/**
 * A scene on the GPU: every mesh in one vertex pool and one index pool, every instance in one storage buffer, and per
 * (mesh, level) "slot" a list of visible instances and its indirect draw, filled each frame by the culling pass
 * (src/shaders/cull.wgsl). The CPU's work per frame does not grow with the number of instances.
 *
 * The meshes a scene leaves to be fetched when the eye comes near (MeshData.lazy: a building's finer levels) get
 * buffers of their own when they arrive; until all the meshes of such a level are there, the level's range is given
 * to the next level (its distance in the batch made empty), so the building draws its coarser level and dissolves
 * into the finer one once it is ready.
 */
import { bufferFrom } from '../gpu/device';
import { INSTANCE_BYTES, VCLASS_ALPHA, VCLASS_OWN, levelMeshes, type LodLevel, type MeshArrays, type MeshData, type SceneData } from './types';

/** interleaved vertex (4-byte words): position (3), normal (3), albedo luminance (1), uv (2), class word (1, u32: bits
 *  0–15 the class of its triangles or 0xffff for the mesh's, bit 16 alpha-tested, bit 17 paving from the paths,
 *  bits 24–31 the surface pattern), the world's paint values as half floats (2: y | z, w | x the surface kind) */
export const VERTEX_FLOATS = 12;

/** a float as an IEEE half (round to nearest), in the low 16 bits */
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
function half(v: number): number {
  F32[0] = v;
  const x = U32[0], s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
  if (e <= 0) return s | (e < -10 ? 0 : ((m | 0x800000) >> (1 - e + 13)));
  if (e >= 31) return s | 0x7c00;
  return s | ((e << 10) + ((m + 0x1000) >> 13));
}
/** a mesh's vertices in the pool's interleaved layout, from `stage` (grown when too small) */
function packVertices(m: MeshData, a: MeshArrays, stage: { f: Float32Array; w: Uint32Array }): number {
  const n = a.positions.length / 3;
  if (stage.f.length < n * VERTEX_FLOATS) { stage.f = new Float32Array(Math.max(n * VERTEX_FLOATS, 1 << 18)); stage.w = new Uint32Array(stage.f.buffer); }
  const f = stage.f, words = stage.w;
  for (let j = 0; j < n; j++) {
    const o = j * VERTEX_FLOATS;
    f[o] = a.positions[j * 3]; f[o + 1] = a.positions[j * 3 + 1]; f[o + 2] = a.positions[j * 3 + 2];
    f[o + 3] = a.normals[j * 3]; f[o + 4] = a.normals[j * 3 + 1]; f[o + 5] = a.normals[j * 3 + 2];
    f[o + 6] = a.tones ? a.tones[j] : m.tone;
    f[o + 7] = a.uvs ? a.uvs[j * 2] : 0; f[o + 8] = a.uvs ? a.uvs[j * 2 + 1] : 0;
    words[o + 9] = (a.vclass ? a.vclass[j] : VCLASS_OWN | (m.mask?.all ? VCLASS_ALPHA : 0)) | ((a.patterns ? a.patterns[j] & 0xff : 0) << 24);
    const pa = a.paint;
    words[o + 10] = pa ? half(pa[j * 4 + 1]) | (half(pa[j * 4 + 2]) << 16) : 0;
    words[o + 11] = pa ? half(pa[j * 4 + 3]) | (half(pa[j * 4]) << 16) : 0;
  }
  return n;
}

/** a level of a one-instance batch whose meshes are fetched when the eye comes near */
interface LazyLevel { batch: number; level: number; meshes: number[]; centre: [number, number, number]; radius: number; state: 'idle' | 'loading' | 'ready' | 'failed' }

/** the instance lists per slot: 0 the view, 1 + k shadow cascade k (src/shaders/frame.wgsl CASCADES), 3 the view's
 *  instances dissolving between levels, 4 the view's second phase (seen only by the occlusion test after the first) */
export const PASSES = 5;

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
  /** metres of lift per metre of eye distance */
  lift: number;
  /** the seasons it appears in (bit 0 spring … 3 winter) */
  seasons: number;
  /** a far impostor's silhouette + 1 (0: an ordinary mesh) */
  billboard: number;
  /** the looks it appears in (bit = look id; 0: every look) */
  looks: number;
  /** the viewpoint whose stage it is (−1: none), and the viewpoints whose stage hides it (bits) */
  stage: number;
  unstage: number;
  /** a mesh fetched when the eye comes near: drawn once it is there, from buffers of its own */
  lazy: boolean;
  ready: boolean;
  vbuf?: GPUBuffer;
  ibuf?: GPUBuffer;
}

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

export class GpuScene {
  readonly vertices: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly instances: GPUBuffer;
  readonly batchOf: GPUBuffer;
  readonly batches: GPUBuffer;
  readonly slotBase: GPUBuffer;
  readonly lodState: GPUBuffer;
  /** per instance, 1 where the last occlusion test saw it (the next frame's first phase draws those) */
  readonly seen: GPUBuffer;
  /** indirect draw arguments, 5 words per slot; instanceCount zeroed each frame from `argsTemplate` */
  readonly args: GPUBuffer;
  readonly argsTemplate: GPUBuffer;
  readonly visible: GPUBuffer;
  private readonly argsData: Uint32Array<ArrayBuffer>;

  /** a season, a look: the draws of the meshes out of them get no triangles (they cost nothing) */
  setSeason(device: GPUDevice, season: string): void { this.season = season; this.writeTemplate(device); }
  setLook(device: GPUDevice, look: number): void { this.look = look; this.writeTemplate(device); }
  /** the viewpoint the eye stands at (−1: none): its stage shows, what the stage moves hides */
  setStage(device: GPUDevice, at: number): void { this.at = at; this.writeTemplate(device); }
  private season = 'spring';
  private look = -1;
  private at = -1;
  private writeTemplate(device: GPUDevice): void {
    const bit = 1 << Math.max(0, SEASONS.indexOf(this.season));
    const lb = this.look >= 0 && this.look < 32 ? 1 << this.look : 0;
    const vb = this.at >= 0 && this.at < 32 ? 1 << this.at : 0;
    const shown = (s: Slot) => (!s.lazy || s.ready) && !!(s.seasons & bit) && (!s.looks || !!(s.looks & lb)) && (s.stage < 0 ? !(s.unstage & vb) : s.stage === this.at);
    const a = this.argsData;
    for (let p = 0; p < PASSES; p++) this.slots.forEach((s, i) => { a[(p * this.slots.length + i) * 5] = shown(s) ? s.indexCount : 0; });
    device.queue.writeBuffer(this.argsTemplate, 0, a);
  }
  readonly slots: Slot[] = [];
  readonly instanceCount: number;
  readonly triangles: number;
  /** the length of one pass's visible lists */
  readonly visibleTotal: number;

  /** the levels fetched when the eye comes near, and each batch's level distances as the levels stand now */
  private readonly lazyLevels: LazyLevel[] = [];
  private readonly levelTo: Float32Array;
  private readonly batchTo: number[][] = [];
  private readonly meshState = new Map<number, Promise<void>>();
  private loading = 0;
  /** levels being fetched, or due (the eye within their reach) and not yet started */
  get pending(): number { return this.loading + this.due; }
  private due = 0;

  constructor(device: GPUDevice, private readonly scene: SceneData) {
    // the pools, filled mesh by mesh through one small staging array (a city's geometry never sits in one JS array);
    // the meshes fetched later take no room in them
    let nv = 0, ni = 0;
    for (const m of scene.meshes) { nv += m.positions.length / 3; ni += m.indices.length; }
    this.vertices = device.createBuffer({ label: 'mo vertices', size: Math.max(16, nv * VERTEX_FLOATS * 4), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.indices = device.createBuffer({ label: 'mo indices', size: Math.max(16, ni * 4), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    const where: { baseVertex: number; firstIndex: number }[] = [];
    const stage = { f: new Float32Array(0), w: new Uint32Array(0) };
    let v = 0, k = 0, tris = 0;
    for (const m of scene.meshes) {
      where.push({ baseVertex: m.lazy ? 0 : v, firstIndex: m.lazy ? 0 : k });
      const n = packVertices(m, m, stage);
      if (n) device.queue.writeBuffer(this.vertices, v * VERTEX_FLOATS * 4, stage.f, 0, n * VERTEX_FLOATS);
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
          this.slots.push({ level: li, lazy: !!m.lazy, ready: false,
            mesh: mi, indexCount: m.lazy?.indexCount ?? m.indices.length, firstIndex: where[mi].firstIndex, baseVertex: where[mi].baseVertex,
            visibleBase: visibleTotal, capacity: b.count, cls: m.cls, tone: m.tone, hasTone: !!m.tones, cutoff: m.mask?.cutoff ?? 0, lift: m.lift ?? 0,
            seasons: m.seasons ? m.seasons.reduce((b, s) => b | (SEASONS.indexOf(s) >= 0 ? 1 << SEASONS.indexOf(s) : 0), 0) : 15,
            billboard: m.billboard !== undefined ? m.billboard + 1 : 0,
            looks: m.looks ? m.looks.reduce((b, id) => b | (id >= 0 && id < 32 ? 1 << id : 0), 0) : 0,
            stage: m.stage ?? -1,
            unstage: m.unstage ? m.unstage.reduce((b, id) => b | (id >= 0 && id < 32 ? 1 << id : 0), 0) : 0,
          });
          visibleTotal += b.count;
          tris += ((m.lazy?.indexCount ?? m.indices.length) / 3) * b.count;
        }
      });
      batchOf.fill(bi, b.first, b.first + b.count);
      // the sphere the level is chosen by: the group's own, else its first mesh's
      const m0 = levels.map(levelMeshes).find((x) => x.length)?.[0];
      const bd = g?.bounds ?? (m0 !== undefined ? { center: scene.meshes[m0].center, radius: scene.meshes[m0].radius } : { center: [0, 0, 0], radius: 0 });
      // (the coarsest level that casts a shadow: an impostor casts none)
      let lastCast = levels.length - 1;
      while (lastCast > 0 && levelMeshes(levels[lastCast]).some((mi) => scene.meshes[mi].billboard !== undefined)) lastCast--;
      bu.set([first, levels.length | (shadowFrom << 8) | (lastCast << 16), b.first, b.count], bi * 16);
      // (info.z: the distance beyond which it casts no shadow; the shader does not read the first instance)
      bf[bi * 16 + 2] = g?.shadowTo ?? 1e9;
      this.batchTo[bi] = [...levels.map((l) => l.to), ...Array(4 - levels.length).fill(1e9)];
      bf.set([...bd.center, bd.radius], bi * 16 + 8);
      bu.set(spans, bi * 16 + 12);
      // the levels whose meshes come later (a one-instance batch: where the building stands is known now)
      if (g && b.count === 1) {
        levels.forEach((l, li) => {
          const ms = levelMeshes(l);
          if (!ms.some((mi) => scene.meshes[mi].lazy)) return;
          const I = new Float32Array(scene.instances, b.first * INSTANCE_BYTES, 12);
          const c = bd.center;
          const centre: [number, number, number] = [0, 1, 2].map((r) => I[r] * c[0] + I[3 + r] * c[1] + I[6 + r] * c[2] + I[9 + r]) as [number, number, number];
          const s = Math.max(Math.hypot(I[0], I[1], I[2]), Math.hypot(I[3], I[4], I[5]), Math.hypot(I[6], I[7], I[8]));
          this.lazyLevels.push({ batch: bi, level: li, meshes: ms, centre, radius: bd.radius * s, state: 'idle' });
        });
      }
    });
    this.levelTo = bf;
    for (let bi = 0; bi < scene.batches.length; bi++) bf.set(this.effectiveTo(bi), bi * 16 + 4);
    this.triangles = tris;
    this.batchOf = bufferFrom(device, batchOf, GPUBufferUsage.STORAGE, 'mo batchOf');
    this.batches = bufferFrom(device, new Uint8Array(binfo), GPUBufferUsage.STORAGE, 'mo batches');
    this.slotBase = bufferFrom(device, new Uint32Array(this.slots.map((s) => s.visibleBase)), GPUBufferUsage.STORAGE, 'mo slotBase');
    this.lodState = bufferFrom(device, new Uint32Array(scene.instanceCount).fill(0xffff), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, 'mo lodState');
    // (the state word: no level (0xff) and none being left (0xff) — a 0 there would read as dissolving out of level 0)
    this.seen = bufferFrom(device, new Uint32Array(scene.instanceCount).fill(1), GPUBufferUsage.STORAGE, 'mo seen');
    // one set of draws per pass (the view, then each cascade)
    const args = new Uint32Array(this.slots.length * 5 * PASSES);
    for (let p = 0; p < PASSES; p++) this.slots.forEach((s, i) => args.set([s.lazy ? 0 : s.indexCount, 0, s.firstIndex, s.baseVertex, 0], (p * this.slots.length + i) * 5));
    this.argsTemplate = bufferFrom(device, args, GPUBufferUsage.COPY_SRC, 'mo args template');
    this.argsData = args;
    this.args = bufferFrom(device, args, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC, 'mo args');
    this.visibleTotal = visibleTotal;
    this.visible = device.createBuffer({ label: 'mo visible', size: Math.max(16, visibleTotal * 4 * PASSES), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  }

  /** a batch's level distances as they stand: a level not yet fetched gives its range to the next one */
  private effectiveTo(bi: number): number[] {
    const to = this.batchTo[bi].slice();
    // (below 0 for the first level: the distance is 0 with the eye inside the bounds)
    for (const L of this.lazyLevels) if (L.batch === bi && L.state !== 'ready') to[L.level] = L.level === 0 ? -1 : to[L.level - 1];
    // (an empty range keeps its place: the levels after it keep theirs)
    for (let k = 1; k < 4; k++) to[k] = Math.max(to[k], to[k - 1]);
    return to;
  }

  /** fetches the levels the eye has come within reach of (a margin before their range begins), a few at a time;
   *  `ready` runs when one arrives (the draws must be recorded again: its meshes have buffers of their own) */
  stream(device: GPUDevice, eye: readonly number[], lodScale: number, ready: () => void): void {
    let due = 0;
    for (const L of this.lazyLevels) {
      if (L.state !== 'idle') continue;
      const reach = this.batchTo[L.batch][L.level] * lodScale * 1.25 + 60;
      const d = Math.hypot(eye[0] - L.centre[0], eye[1] - L.centre[1], eye[2] - L.centre[2]) - L.radius;
      if (d > reach) continue;
      due++;
      if (this.loading >= 3) continue;
      due--;
      L.state = 'loading'; this.loading++;
      Promise.all(L.meshes.map((mi) => this.fetchMesh(device, mi))).then(() => {
        L.state = 'ready';
        this.writeBatchTo(device, L.batch);
        this.writeTemplate(device);
        ready();
      }, (e) => { L.state = 'failed'; console.error(`[mo] a level of ${this.scene.meshes[L.meshes[0]]?.name} did not arrive`, e); })
        .finally(() => { this.loading--; });
    }
    this.due = due;
  }

  private writeBatchTo(device: GPUDevice, bi: number): void {
    const to = new Float32Array(this.effectiveTo(bi));
    this.levelTo.set(to, bi * 16 + 4);
    device.queue.writeBuffer(this.batches, bi * 64 + 16, to);
  }

  /** one mesh fetched and put in buffers of its own (once, whichever levels share it) */
  private fetchMesh(device: GPUDevice, mi: number): Promise<void> {
    let p = this.meshState.get(mi);
    if (p) return p;
    const m = this.scene.meshes[mi];
    if (!m.lazy) return Promise.resolve();
    p = m.lazy.fetch().then((a) => {
      const stage = { f: new Float32Array(0), w: new Uint32Array(0) };
      const n = packVertices(m, a, stage);
      const vbuf = device.createBuffer({ label: `mo lazy ${m.name}`, size: Math.max(16, n * VERTEX_FLOATS * 4), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(vbuf, 0, stage.f, 0, n * VERTEX_FLOATS);
      const ibuf = device.createBuffer({ label: `mo lazy ${m.name} indices`, size: Math.max(16, a.indices.length * 4), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(ibuf, 0, a.indices as Uint32Array<ArrayBuffer>);
      for (const s of this.slots) if (s.mesh === mi) { s.vbuf = vbuf; s.ibuf = ibuf; s.ready = true; }
    });
    this.meshState.set(mi, p);
    return p;
  }
}
