/**
 * A scene on the GPU: every mesh in one vertex pool and one index pool, every instance in one storage buffer, and per
 * (mesh, level) "slot" a list of visible instances and its indirect draw, filled each frame by the culling pass
 * (src/shaders/cull.wgsl). The CPU's work per frame does not grow with the number of instances.
 */
import { bufferFrom } from '../gpu/device';
import { INSTANCE_BYTES, VCLASS_ALPHA, VCLASS_OWN, type SceneData } from './types';

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
    // the pools
    let nv = 0, ni = 0;
    for (const m of scene.meshes) { nv += m.positions.length / 3; ni += m.indices.length; }
    const vdata = new Float32Array(nv * VERTEX_FLOATS);
    const vwords = new Uint32Array(vdata.buffer);
    const idata = new Uint32Array(ni);
    const where: { baseVertex: number; firstIndex: number }[] = [];
    let v = 0, k = 0, tris = 0;
    for (const m of scene.meshes) {
      const n = m.positions.length / 3;
      where.push({ baseVertex: v, firstIndex: k });
      for (let j = 0; j < n; j++) {
        const o = (v + j) * VERTEX_FLOATS;
        vdata[o] = m.positions[j * 3]; vdata[o + 1] = m.positions[j * 3 + 1]; vdata[o + 2] = m.positions[j * 3 + 2];
        vdata[o + 3] = m.normals[j * 3]; vdata[o + 4] = m.normals[j * 3 + 1]; vdata[o + 5] = m.normals[j * 3 + 2];
        vdata[o + 6] = m.tones ? m.tones[j] : m.tone;
        if (m.uvs) { vdata[o + 7] = m.uvs[j * 2]; vdata[o + 8] = m.uvs[j * 2 + 1]; }
        vwords[o + 9] = (m.vclass ? m.vclass[j] : VCLASS_OWN | (m.mask?.all ? VCLASS_ALPHA : 0)) | ((m.patterns ? m.patterns[j] & 0xff : 0) << 24);
      }
      idata.set(m.indices, k);
      v += n; k += m.indices.length;
    }
    this.vertices = bufferFrom(device, vdata, GPUBufferUsage.VERTEX, 'mo vertices');
    this.indices = bufferFrom(device, idata, GPUBufferUsage.INDEX, 'mo indices');
    this.instances = bufferFrom(device, new Uint8Array(scene.instances, 0, scene.instanceCount * INSTANCE_BYTES), GPUBufferUsage.STORAGE, 'mo instances');
    this.instanceCount = scene.instanceCount;

    // batches → slots (one per mesh, or one per level of a LOD group)
    const batchOf = new Uint32Array(scene.instanceCount);
    const binfo = new ArrayBuffer(Math.max(1, scene.batches.length) * 48);
    const bu = new Uint32Array(binfo), bf = new Float32Array(binfo);
    let visibleTotal = 0;
    scene.batches.forEach((b, bi) => {
      const levels = 'lodGroup' in b ? scene.lodGroups[b.lodGroup].levels : [{ mesh: b.mesh, to: 1e9 }];
      const shadowFrom = 'lodGroup' in b ? Math.min(Math.max(0, scene.lodGroups[b.lodGroup].shadowFrom ?? 0), levels.length - 1) : 0;
      if (levels.length > 4) throw new Error(`[mo] a LOD group has ${levels.length} levels (4 at most)`);
      const first = this.slots.length;
      for (const [li, l] of levels.entries()) {
        const m = scene.meshes[l.mesh];
        this.slots.push({ level: li,
          mesh: l.mesh, indexCount: m.indices.length, firstIndex: where[l.mesh].firstIndex, baseVertex: where[l.mesh].baseVertex,
          visibleBase: visibleTotal, capacity: b.count, cls: m.cls, tone: m.tone, hasTone: !!m.tones, cutoff: m.mask?.cutoff ?? 0,
        });
        visibleTotal += b.count;
        tris += (m.indices.length / 3) * b.count;
      }
      batchOf.fill(bi, b.first, b.first + b.count);
      const m0 = scene.meshes[levels[0].mesh];
      bu.set([first, levels.length | (shadowFrom << 8), b.first, b.count], bi * 12);
      bf.set([...levels.map((l) => l.to), ...Array(4 - levels.length).fill(1e9)], bi * 12 + 4);
      bf.set([...m0.center, m0.radius], bi * 12 + 8);
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
    this.args = bufferFrom(device, args, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT, 'mo args');
    this.visibleTotal = visibleTotal;
    this.visible = device.createBuffer({ label: 'mo visible', size: Math.max(16, visibleTotal * 4 * PASSES), usage: GPUBufferUsage.STORAGE });
  }
}
