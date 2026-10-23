import type { Batch, Heightfield, MeshData, SceneData } from './types';

interface AttrRef { offset: number; format: string }
interface MeshJson {
  name: string; class: number; vertexCount: number; indexCount: number;
  attributes: { position: AttrRef; normal: AttrRef; uv?: AttrRef; tone?: AttrRef; class?: AttrRef; pattern?: AttrRef };
  index: AttrRef; bounds: { center: [number, number, number]; radius: number }; tone?: number;
  mask?: { texture: number; cutoff: number; all?: boolean };
}
interface FieldJson { file: string; origin: [number, number]; cell: number; width: number; depth: number; classMap?: { file: string } }
interface TextureJson { name: string; file: string; width: number; height: number; format: string }
interface SceneJson {
  format: string; version: number; name: string; classes: Record<string, number>;
  meshes: MeshJson[]; lodGroups?: SceneData['lodGroups']; batches: Batch[]; instanceCount: number;
  terrain?: { near?: FieldJson; far?: FieldJson; class?: number };
  water?: SceneData['water']; sun?: { direction: [number, number, number] }; viewpoints?: SceneData['viewpoints'];
  textures?: TextureJson[];
  paths?: SceneData['paths'];
}

async function fetchBuffer(url: URL): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[mo] ${url}: ${r.status}`);
  return r.arrayBuffer();
}

/** a mo-scene directory (docs/SCENE_FORMAT.md) at `base` (ending in /) */
export async function loadMoScene(base: string | URL): Promise<SceneData> {
  const root = new URL(base, location.href);
  const r = await fetch(new URL('scene.json', root));
  if (!r.ok) throw new Error(`[mo] ${root}scene.json: ${r.status}`);
  const j = (await r.json()) as SceneJson;
  if (j.format !== 'mo-scene' || j.version !== 0) throw new Error(`[mo] not a mo-scene v0: ${j.format} ${j.version}`);
  const field = async (f?: FieldJson): Promise<Heightfield | undefined> => f && {
    origin: f.origin, cell: f.cell, width: f.width, depth: f.depth,
    heights: new Float32Array(await fetchBuffer(new URL(f.file, root))),
    classes: f.classMap ? new Uint8Array(await fetchBuffer(new URL(f.classMap.file, root))) : undefined,
  };
  const [geo, inst, near, far, textures] = await Promise.all([
    fetchBuffer(new URL('geometry.bin', root)), fetchBuffer(new URL('instances.bin', root)),
    field(j.terrain?.near), field(j.terrain?.far),
    Promise.all((j.textures ?? []).map(async (t) => {
      if (t.format !== 'r8unorm') throw new Error(`[mo] texture ${t.name}: ${t.format} (r8unorm only)`);
      return { name: t.name, width: t.width, height: t.height, data: new Uint8Array(await fetchBuffer(new URL(t.file, root))) };
    })),
  ]);
  const meshes: MeshData[] = j.meshes.map((m) => {
    const a = m.attributes;
    const f32 = (ref: AttrRef, n: number) => new Float32Array(geo, ref.offset, n);
    return {
      name: m.name, cls: m.class,
      positions: f32(a.position, m.vertexCount * 3),
      normals: f32(a.normal, m.vertexCount * 3),
      tones: a.tone ? f32(a.tone, m.vertexCount) : undefined,
      uvs: a.uv ? f32(a.uv, m.vertexCount * 2) : undefined,
      vclass: a.class ? new Uint32Array(geo, a.class.offset, m.vertexCount) : undefined,
      patterns: a.pattern && a.uv ? new Uint32Array(geo, a.pattern.offset, m.vertexCount) : undefined,
      mask: m.mask ? { texture: m.mask.texture, cutoff: m.mask.cutoff, all: !!m.mask.all } : undefined,
      tone: m.tone ?? 0.5,
      indices: new Uint32Array(geo, m.index.offset, m.indexCount),
      center: m.bounds.center, radius: m.bounds.radius,
    };
  });
  return {
    name: j.name, classes: j.classes, meshes, lodGroups: j.lodGroups ?? [], batches: j.batches,
    instances: inst, instanceCount: j.instanceCount,
    terrain: near || far ? { near, far, cls: j.terrain?.class ?? 1 } : undefined,
    water: j.water ?? [], textures, paths: j.paths ?? [], sun: j.sun?.direction ?? [0.4, 0.5, -0.77], viewpoints: j.viewpoints ?? [],
  };
}
