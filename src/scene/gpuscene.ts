/**
 * A scene on the GPU: every mesh in one vertex pool and one index pool, every instance in one storage buffer, and per
 * (mesh, level) "slot" a list of visible instances and its indirect draw, filled each frame by the culling pass
 * (src/shaders/cull.wgsl). The CPU's work per frame does not grow with the number of instances.
 */
import { bufferFrom } from '../gpu/device';
import { INSTANCE_BYTES, VCLASS_ALPHA, VCLASS_OWN, levelMeshes, type LodLevel, type SceneData } from './types';

/** interleaved vertex (4-byte words): position (3), normal (3), albedo luminance (1), uv (2), class word (1, u32: bits
 *  0–15 the class of its triangles or 0xffff for the mesh's, bit 16 alpha-tested, bit 17 paving from the paths,
 *  bits 24–31 the surface pattern) */
export const VERTEX_FLOATS = 10;
/** passes the culling fills: the view, then each shadow cascade (src/shaders/frame.wgsl CASCADES) */
export const PASSES = 3;

export interface Slot {
  mesh: number;
  indexCount: number;
  firstIndex: number;
  baseVertex: number;
  /** where this slot's visible list starts */
  visibleBase: number;
  capacity: number;
  cls: number;
  tone: number;
  hasTone: boolean;
  /** the LOD level this slot holds (0 for a plain mesh) */
  level: number;
  /** alpha cutoff of its alpha-tested triangles (0: none) */
  cutoff: number;
}

export class GpuScene {
  readonly vertices: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly instances: GPUBuffer;
  readonly batchOf: GPUBuffer;
  readonly batches: GPUBuffer;
  readonly slotBase: GPUBuffer;
  readonly lodState: GPUBuffer;
  /** indirect draw arguments, 5 words per slot; instanceCount zeroed each frame from `argsTemplate` */
  readonly args: GPUBuffer;
  readonly argsTemplate: GPUBuffer;
  readonly visible: GPUBuffer;
  readonly slots: Slot[] = [];
  readonly instanceCount: number;
  readonly triangles: number;
  /** the length of one pass's visible lists */
  readonly visibleTotal: number;

  constructor(device: GPUDevice, scene: SceneData) {
    // the pools, filled mesh by mesh through one small staging array (a city's geometry never sits in one JS array)
    let nv = 0, ni = 0;
    for (const m of scene.meshes) { nv += m.positions.length / 3; ni += m.indices.length; }
    this.vertices = device.createBuffer({ label: 'mo vertices', size: Math.max(16, nv * VERTEX_FLOATS * 4), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.indices = device.createBuffer({ label: 'mo indices', size: Math.max(16, ni * 4), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    const where: { baseVertex: number; firstIndex: number }[] = [];
    let stage = new Float32Array(0), words = new Uint32Array(0);
    let v = 0, k = 0, tris = 0;
    for (const m of scene.meshes) {
      const n = m.positions.length / 3;
      where.push({ baseVertex: v, firstIndex: k });
      if (stage.length < n * VERTEX_FLOATS) { stage = new Float32Array(Math.max(n * VERTEX_FLOATS, 1 << 18)); words = new Uint32Array(stage.buffer); }
      for (let j = 0; j < n; j++) {
        const o = j * VERTEX_FLOATS;
        stage[o] = m.positions[j * 3]; stage[o + 1] = m.positions[j * 3 + 1]; stage[o + 2] = m.positions[j * 3 + 2];
        stage[o + 3] = m.normals[j * 3]; stage[o + 4] = m.normals[j * 3 + 1]; stage[o + 5] = m.normals[j * 3 + 2];
        stage[o + 6] = m.tones ? m.tones[j] : m.tone;
        stage[o + 7] = m.uvs ? m.uvs[j * 2] : 0; stage[o + 8] = m.uvs ? m.uvs[j * 2 + 1] : 0;
        words[o + 9] = (m.vclass ? m.vclass[j] : VCLASS_OWN | (m.mask?.all ? VCLASS_ALPHA : 0)) | ((m.patterns ? m.patterns[j] & 0xff : 0) << 24);
      }
      if (n) device.queue.writeBuffer(this.vertices, v * VERTEX_FLOATS * 4, stage, 0, n * VERTEX_FLOATS);
      if (m.indices.length) device.queue.writeBuffer(this.indices, k * 4, m.indices as Uint32Array<ArrayBuffer>);
      v += n; k += m.indices.length;
    }
    this.instances = bufferFrom(device, new Uint8Array(scene.instances, 0, scene.instanceCount * INSTANCE_BYTES), GPUBufferUsage.STORAGE, 'mo instances');
    this.instanceCount = scene.instanceCount;

    // batches → slots: one per mesh, or one per mesh of each level of a LOD group (a level may have several, or none)
    const batchOf = new Uint32Array(scene.instanceCount);
    const binfo = new ArrayBuffer(Math.max(1, scene.batches.length) * 64);
    const bu = new Uint32Array(binfo), bf = new Float32Array(binfo);
    let visibleTotal = 0;
    scene.batches.forEach((b, bi) => {
      const g = 'lodGroup' in b ? scene.lodGroups[b.lodGroup] : undefined;
      const levels: LodLevel[] = g ? g.levels : [{ mesh: (b as { mesh: number }).mesh, to: 1e9 }];
      if (levels.length > 4) throw new Error(`[mo] LOD group ${g?.name} has ${levels.length} levels (4 at most)`);
      const shadowFrom = g ? Math.min(Math.max(0, g.shadowFrom ?? 0), levels.length - 1) : 0;
      const first = this.slots.length;
      const spans = [0, 0, 0, 0];
      levels.forEach((l, li) => {
        const ms = levelMeshes(l);
        if (ms.length > 64) throw new Error(`[mo] LOD group ${g?.name} level ${li} has ${ms.length} meshes (64 at most)`);
        spans[li] = (this.slots.length - first) | (ms.length << 16);
        for (const mi of ms) {
          const m = scene.meshes[mi];
          this.slots.push({ level: li,
            mesh: mi, indexCount: m.indices.length, firstIndex: where[mi].firstIndex, baseVertex: where[mi].baseVertex,
            visibleBase: visibleTotal, capacity: b.count, cls: m.cls, tone: m.tone, hasTone: !!m.tones, cutoff: m.mask?.cutoff ?? 0,
          });
          visibleTotal += b.count;
          tris += (m.indices.length / 3) * b.count;
        }
      });
      batchOf.fill(bi, b.first, b.first + b.count);
      // the sphere the level is chosen by: the group's own, else its first mesh's
      const m0 = levels.map(levelMeshes).find((x) => x.length)?.[0];
      const bd = g?.bounds ?? (m0 !== undefined ? { center: scene.meshes[m0].center, radius: scene.meshes[m0].radius } : { center: [0, 0, 0], radius: 0 });
      bu.set([first, levels.length | (shadowFrom << 8), b.first, b.count], bi * 16);
      bf.set([...levels.map((l) => l.to), ...Array(4 - levels.length).fill(1e9)], bi * 16 + 4);
      bf.set([...bd.center, bd.radius], bi * 16 + 8);
      bu.set(spans, bi * 16 + 12);
    });
    this.triangles = tris;
    this.batchOf = bufferFrom(device, batchOf, GPUBufferUsage.STORAGE, 'mo batchOf');
    this.batches = bufferFrom(device, new Uint8Array(binfo), GPUBufferUsage.STORAGE, 'mo batches');
    this.slotBase = bufferFrom(device, new Uint32Array(this.slots.map((s) => s.visibleBase)), GPUBufferUsage.STORAGE, 'mo slotBase');
    this.lodState = bufferFrom(device, new Uint32Array(scene.instanceCount).fill(0xff), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, 'mo lodState');
    // one set of draws per pass (the view, then each cascade)
    const args = new Uint32Array(this.slots.length * 5 * PASSES);
    for (let p = 0; p < PASSES; p++) this.slots.forEach((s, i) => args.set([s.indexCount, 0, s.firstIndex, s.baseVertex, 0], (p * this.slots.length + i) * 5));
    this.argsTemplate = bufferFrom(device, args, GPUBufferUsage.COPY_SRC, 'mo args template');
    this.args = bufferFrom(device, args, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC, 'mo args');
    this.visibleTotal = visibleTotal;
    this.visible = device.createBuffer({ label: 'mo visible', size: Math.max(16, visibleTotal * 4 * PASSES), usage: GPUBufferUsage.STORAGE });
  }
}
