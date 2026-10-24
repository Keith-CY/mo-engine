import type { Batch, Heightfield, MeshArrays, MeshData, SceneData } from './types';

/** a byte range in one of the scene's geometry files (docs/SCENE_FORMAT.md, Large scenes), or in one of the files
 *  fetched when the eye comes near (`lazy`); a packed array's range (min, max) and whether it is stored as differences */
interface AttrRef { offset: number; format: string; file?: number; lazy?: number; min?: number[]; max?: number[]; delta?: boolean }
interface MeshJson {
  name: string; class: number; vertexCount: number; indexCount: number;
  attributes: { position: AttrRef; normal: AttrRef; uv?: AttrRef; tone?: AttrRef; class?: AttrRef; pattern?: AttrRef; paint?: AttrRef };
  index: AttrRef; bounds: { center: [number, number, number]; radius: number }; tone?: number;
  mask?: { texture: number; cutoff: number; all?: boolean };
  lift?: number;
  seasons?: string[];
  billboard?: number;
  looks?: number[];
  stage?: number;
  unstage?: number[];
}
/** a heightfield in one file, or in bands of `rowsPerFile` rows (heights float32, or unorm16 over min … max, each
 *  band its own run of differences when `delta`) */
interface FieldJson {
  file: string | string[]; rowsPerFile?: number; origin: [number, number]; cell: number; width: number; depth: number; classMap?: { file: string | string[] };
  format?: 'float32' | 'unorm16'; min?: number; max?: number; delta?: boolean;
}
interface TextureJson { name: string; file: string; width: number; height: number; format: string }
interface SceneJson {
  format: string; version: number; name: string; classes: Record<string, number>;
  meshes: MeshJson[]; lodGroups?: SceneData['lodGroups']; batches: Batch[]; instanceCount: number;
  terrain?: { near?: FieldJson; far?: FieldJson; class?: number };
  water?: SceneData['water']; sun?: { direction: [number, number, number] }; viewpoints?: SceneData['viewpoints'];
  textures?: TextureJson[];
  paths?: SceneData['paths'];
  geometry?: string[];
  geometryLazy?: string[];
  instanceFile?: string;
  instanceFiles?: string[];
  looks?: SceneData['looks'];
  walk?: SceneData['walk'];
  surfaces?: string;
}

// ---- packed arrays (tools/pack-scene.mjs --compact): decoded into the engine's layout
const HALF = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    t[h] = s * (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15));
  }
  return t;
})();
/** a component-by-component run of differences added up again, back to the vertices' own order */
function undelta<T extends Uint8Array | Uint16Array | Uint32Array>(a: T, c: number, delta: boolean | undefined): T {
  if (!delta) return a;
  const n = a.length / c;
  const out = new (a.constructor as new (n: number) => T)(a.length);
  // (the sums wrap like the type)
  const wide = a.BYTES_PER_ELEMENT === 4, mask = a.BYTES_PER_ELEMENT === 2 ? 0xffff : 0xff;
  for (let k = 0; k < c; k++) {
    let v = 0;
    for (let i = 0; i < n; i++) { v = wide ? (v + a[k * n + i]) >>> 0 : (v + a[k * n + i]) & mask; out[i * c + k] = v; }
  }
  return out;
}
/** one array (`count` values of `comps` components; normals come back as 3) in the engine's layout */
function decode(buf: ArrayBuffer, ref: AttrRef, count: number, comps: number): Float32Array | Uint32Array {
  const o = ref.offset, f = ref.format;
  if (f.startsWith('float32')) return new Float32Array(buf, o, count * comps);
  if (f === 'uint32' && !ref.delta) return new Uint32Array(buf, o, count * comps);
  if (f === 'uint8' || f === 'uint16' || f === 'uint32') {
    const T = f === 'uint8' ? Uint8Array : f === 'uint16' ? Uint16Array : Uint32Array;
    return Uint32Array.from(undelta(new T(buf, o, count * comps), comps, ref.delta));
  }
  if (f.startsWith('unorm16')) {
    const q = undelta(new Uint16Array(buf, o, count * comps), comps, ref.delta);
    const out = new Float32Array(q.length), lo = ref.min ?? [], hi = ref.max ?? [];
    for (let k = 0; k < comps; k++) {
      const a = lo[k] ?? 0, s = ((hi[k] ?? 0) - a) / 65535;
      for (let i = k; i < q.length; i += comps) out[i] = a + q[i] * s;
    }
    return out;
  }
  if (f === 'snorm16x2oct') {
    const u = undelta(new Uint16Array(buf, o, count * 2), 2, ref.delta);
    const q = new Int16Array(u.buffer, u.byteOffset, u.length);
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      let x = Math.max(-1, q[i * 2] / 32767), y = Math.max(-1, q[i * 2 + 1] / 32767);
      const z = 1 - Math.abs(x) - Math.abs(y);
      if (z < 0) { const ox = x; x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1); y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1); }
      const l = Math.hypot(x, y, z) || 1;
      out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
    }
    return out;
  }
  if (f === 'float16x4') {
    const q = undelta(new Uint16Array(buf, o, count * 4), 4, ref.delta);
    const out = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) out[i] = HALF[q[i]];
    return out;
  }
  throw new Error(`[mo] unknown array format ${f}`);
}
/** a fetched file, inflated when gzipped (a host may have inflated it already: the bytes tell) */
async function inflate(b: ArrayBuffer): Promise<ArrayBuffer> {
  const u = new Uint8Array(b, 0, Math.min(2, b.byteLength));
  if (u[0] !== 0x1f || u[1] !== 0x8b) return b;
  return new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export interface LoadOptions {
  /** called as each of the scene's binary files arrives: files done, files in all, bytes so far */
  onProgress?: (done: number, total: number, bytes: number) => void;
}

/** a mo-scene directory (docs/SCENE_FORMAT.md) at `base` (ending in /) */
export async function loadMoScene(base: string | URL, opts: LoadOptions = {}): Promise<SceneData> {
  const root = new URL(base, location.href);
  const r = await fetch(new URL('scene.json', root));
  if (!r.ok) throw new Error(`[mo] ${root}scene.json: ${r.status}`);
  const j = (await r.json()) as SceneJson;
  if (j.format !== 'mo-scene' || j.version !== 0) throw new Error(`[mo] not a mo-scene v0: ${j.format} ${j.version}`);
  const files = (f?: string | string[]) => (f === undefined ? 0 : Array.isArray(f) ? f.length : 1);
  const fieldFiles = (f?: FieldJson) => (f ? files(f.file) + files(f.classMap?.file) : 0);
  const total = (j.geometry?.length ?? 1) + (j.instanceFiles?.length || 1) + fieldFiles(j.terrain?.near) + fieldFiles(j.terrain?.far) + (j.textures?.length ?? 0);
  let done = 0, bytes = 0;
  const fetchBuffer = async (url: URL): Promise<ArrayBuffer> => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`[mo] ${url}: ${r.status}`);
    const b = await r.arrayBuffer();
    bytes += b.byteLength;
    opts.onProgress?.(++done, total, bytes);
    return inflate(b);
  };
  // a field's bands (or its one file) joined into one array
  const banded = async <T extends Float32Array | Uint8Array>(files: string | string[], make: (b: ArrayBuffer) => T, n: number, alloc: (n: number) => T): Promise<T> => {
    const list = Array.isArray(files) ? files : [files];
    if (list.length === 1) return make(await fetchBuffer(new URL(list[0], root)));
    const out = alloc(n);
    let o = 0;
    for (const part of await Promise.all(list.map((f) => fetchBuffer(new URL(f, root))))) { const a = make(part); out.set(a, o); o += a.length; }
    if (o !== n) throw new Error(`[mo] a banded field holds ${o} samples, not ${n}`);
    return out;
  };
  // (16-bit heights over the field's range, each band its own run of differences)
  const heights = (b: ArrayBuffer, f: FieldJson): Float32Array => {
    if ((f.format ?? 'float32') === 'float32') return new Float32Array(b);
    const q = undelta(new Uint16Array(b), 1, f.delta), lo = f.min ?? 0, s = ((f.max ?? 0) - lo) / 65535;
    const out = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) out[i] = lo + q[i] * s;
    return out;
  };
  const field = async (f?: FieldJson): Promise<Heightfield | undefined> => f && {
    origin: f.origin, cell: f.cell, width: f.width, depth: f.depth,
    heights: await banded(f.file, (b) => heights(b, f), f.width * f.depth, (n) => new Float32Array(n)),
    classes: f.classMap ? await banded(f.classMap.file, (b) => new Uint8Array(b), f.width * f.depth, (n) => new Uint8Array(n)) : undefined,
  };
  // the geometry files, a few at a time
  const gfiles = j.geometry ?? ['geometry.bin'];
  const geo: ArrayBuffer[] = new Array(gfiles.length);
  const fetchGeometry = async () => {
    let next = 0;
    const worker = async () => { for (let k = next++; k < gfiles.length; k = next++) geo[k] = await fetchBuffer(new URL(gfiles[k], root)); };
    await Promise.all(Array.from({ length: Math.min(4, gfiles.length) }, worker));
  };
  const [, inst, near, far, textures] = await Promise.all([
    fetchGeometry(),
    // (instances in bands of whole records when they pass a file's size: joined, they are instances.bin)
    j.instanceFiles?.length
      ? Promise.all(j.instanceFiles.map((f) => fetchBuffer(new URL(f, root)))).then((parts) => {
        const out = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
        let o = 0;
        for (const p of parts) { out.set(new Uint8Array(p), o); o += p.byteLength; }
        return out.buffer;
      })
      : fetchBuffer(new URL(j.instanceFile ?? 'instances.bin', root)),
    field(j.terrain?.near), field(j.terrain?.far),
    Promise.all((j.textures ?? []).map(async (t) => {
      if (t.format !== 'r8unorm') throw new Error(`[mo] texture ${t.name}: ${t.format} (r8unorm only)`);
      return { name: t.name, width: t.width, height: t.height, data: new Uint8Array(await fetchBuffer(new URL(t.file, root))) };
    })),
  ]);
  // a mesh's arrays out of the buffers its ranges lie in
  const arraysOf = (m: MeshJson, buf: (ref: AttrRef) => ArrayBuffer): MeshArrays => {
    const a = m.attributes, n = m.vertexCount;
    const f32 = (ref: AttrRef, c: number) => decode(buf(ref), ref, n, c) as Float32Array;
    const u32 = (ref: AttrRef) => decode(buf(ref), ref, n, 1) as Uint32Array;
    return {
      positions: f32(a.position, 3), normals: f32(a.normal, 3),
      tones: a.tone ? f32(a.tone, 1) : undefined,
      uvs: a.uv ? f32(a.uv, 2) : undefined,
      vclass: a.class ? u32(a.class) : undefined,
      patterns: a.pattern && a.uv ? u32(a.pattern) : undefined,
      paint: a.paint ? f32(a.paint, 4) : undefined,
      indices: decode(buf(m.index), m.index, m.indexCount, 1) as Uint32Array,
    };
  };
  // the files fetched when the eye comes near: each once, on the first mesh that needs it
  const lazyFiles = new Map<number, Promise<ArrayBuffer>>();
  const lazyFile = (k: number) => {
    let p = lazyFiles.get(k);
    if (!p) {
      p = fetch(new URL(j.geometryLazy![k], root)).then((r) => { if (!r.ok) throw new Error(`[mo] ${j.geometryLazy![k]}: ${r.status}`); return r.arrayBuffer(); }).then(inflate);
      lazyFiles.set(k, p);
    }
    return p;
  };
  const meshes: MeshData[] = j.meshes.map((m) => {
    const lazy = m.index.lazy;
    const arrays: MeshArrays = lazy === undefined ? arraysOf(m, (ref) => geo[ref.file ?? 0])
      : { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) };
    return {
      name: m.name, cls: m.class, ...arrays,
      mask: m.mask ? { texture: m.mask.texture, cutoff: m.mask.cutoff, all: !!m.mask.all } : undefined,
      tone: m.tone ?? 0.5, lift: m.lift, seasons: m.seasons, billboard: m.billboard, looks: m.looks, stage: m.stage, unstage: m.unstage,
      center: m.bounds.center, radius: m.bounds.radius,
      ...(lazy === undefined ? {} : { lazy: { vertexCount: m.vertexCount, indexCount: m.indexCount, fetch: async () => { const b = await lazyFile(lazy); return arraysOf(m, () => b); } } }),
    };
  });
  return {
    name: j.name, classes: j.classes, meshes, lodGroups: j.lodGroups ?? [], batches: j.batches,
    instances: inst, instanceCount: j.instanceCount,
    terrain: near || far ? { near, far, cls: j.terrain?.class ?? 1 } : undefined,
    water: j.water ?? [], textures, paths: j.paths ?? [], sun: j.sun?.direction ?? [0.4, 0.5, -0.77], viewpoints: j.viewpoints ?? [],
    looks: j.looks ?? [], walk: j.walk,
    // (the world's surface functions, WGSL, compiled into the G-buffer)
    surfaces: j.surfaces ? await (await fetch(new URL(j.surfaces, root))).text() : undefined,
  };
}
