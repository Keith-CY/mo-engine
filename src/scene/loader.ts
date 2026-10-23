import type { Batch, Heightfield, MeshData, SceneData } from './types';

/** a byte range in one of the scene's geometry files (docs/SCENE_FORMAT.md, Large scenes) */
interface AttrRef { offset: number; format: string; file?: number }
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
/** a heightfield in one file, or in bands of `rowsPerFile` rows */
interface FieldJson { file: string | string[]; rowsPerFile?: number; origin: [number, number]; cell: number; width: number; depth: number; classMap?: { file: string | string[] } }
interface TextureJson { name: string; file: string; width: number; height: number; format: string }
interface SceneJson {
  format: string; version: number; name: string; classes: Record<string, number>;
  meshes: MeshJson[]; lodGroups?: SceneData['lodGroups']; batches: Batch[]; instanceCount: number;
  terrain?: { near?: FieldJson; far?: FieldJson; class?: number };
  water?: SceneData['water']; sun?: { direction: [number, number, number] }; viewpoints?: SceneData['viewpoints'];
  textures?: TextureJson[];
  paths?: SceneData['paths'];
  geometry?: string[];
  instanceFiles?: string[];
  looks?: SceneData['looks'];
  walk?: SceneData['walk'];
  surfaces?: string;
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
    return b;
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
  const field = async (f?: FieldJson): Promise<Heightfield | undefined> => f && {
    origin: f.origin, cell: f.cell, width: f.width, depth: f.depth,
    heights: await banded(f.file, (b) => new Float32Array(b), f.width * f.depth, (n) => new Float32Array(n)),
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
      : fetchBuffer(new URL('instances.bin', root)),
    field(j.terrain?.near), field(j.terrain?.far),
    Promise.all((j.textures ?? []).map(async (t) => {
      if (t.format !== 'r8unorm') throw new Error(`[mo] texture ${t.name}: ${t.format} (r8unorm only)`);
      return { name: t.name, width: t.width, height: t.height, data: new Uint8Array(await fetchBuffer(new URL(t.file, root))) };
    })),
  ]);
  const meshes: MeshData[] = j.meshes.map((m) => {
    const a = m.attributes;
    const buf = (ref: AttrRef) => geo[ref.file ?? 0];
    const f32 = (ref: AttrRef, n: number) => new Float32Array(buf(ref), ref.offset, n);
    const u32 = (ref: AttrRef, n: number) => new Uint32Array(buf(ref), ref.offset, n);
    return {
      name: m.name, cls: m.class,
      positions: f32(a.position, m.vertexCount * 3),
      normals: f32(a.normal, m.vertexCount * 3),
      tones: a.tone ? f32(a.tone, m.vertexCount) : undefined,
      uvs: a.uv ? f32(a.uv, m.vertexCount * 2) : undefined,
      vclass: a.class ? u32(a.class, m.vertexCount) : undefined,
      patterns: a.pattern && a.uv ? u32(a.pattern, m.vertexCount) : undefined,
      paint: a.paint ? f32(a.paint, m.vertexCount * 4) : undefined,
      mask: m.mask ? { texture: m.mask.texture, cutoff: m.mask.cutoff, all: !!m.mask.all } : undefined,
      tone: m.tone ?? 0.5, lift: m.lift, seasons: m.seasons, billboard: m.billboard, looks: m.looks, stage: m.stage, unstage: m.unstage,
      indices: u32(m.index, m.indexCount),
      center: m.bounds.center, radius: m.bounds.radius,
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
