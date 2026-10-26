/**
 * A world in memory, as a mo-scene describes it (docs/SCENE_FORMAT.md): meshes, LOD groups, batches of instances,
 * terrain heightfields, water, the sun and the viewpoints.
 */
export interface MeshData {
  name: string;
  cls: number;
  positions: Float32Array;
  normals: Float32Array;
  /** albedo luminance per vertex (0..1); absent: `tone` for the whole mesh */
  tones?: Float32Array;
  uvs?: Float32Array;
  /** per vertex: bits 0–15 the class of its triangles (0xffff: the mesh's), bit 16 alpha-tested */
  vclass?: Uint32Array;
  /** per vertex: the surface pattern its joints are drawn from (PATTERN), read off the metric uv */
  patterns?: Uint32Array;
  /** the alpha mask of its alpha-tested triangles (`all`: every triangle, when there is no vclass) */
  mask?: { texture: number; cutoff: number; all: boolean };
  tone: number;
  indices: Uint32Array;
  /** lifted toward the sky by this many metres per metre of eye distance (ground covers the coarse far terrain would
   *  swallow) */
  lift?: number;
  /** the seasons it appears in (absent: all) */
  seasons?: string[];
  /** a far impostor: a quad (±R across, its height up; uv the card's own coordinates, x −1 … 1 across, y 0 … 1 up)
   *  turned about the instance's up axis toward the eye, cut to a tree's silhouette: 0 dome, 1 pine, 2 willow,
   *  3 small round head, 4 ovoid */
  billboard?: number;
  /** the looks (ids) it appears in (absent: all): a painting's own staging, shown only in its look */
  looks?: number[];
  /** a viewpoint's stage (its id): what only its painting moves or enlarges, shown only while the eye stands there */
  stage?: number;
  /** the viewpoints (ids) whose stage moves it: hidden while the eye stands at one of them */
  unstage?: number[];
  /** per vertex 4 values for the world's surface functions (x: the surface kind, 0 none) */
  paint?: Float32Array;
  /** bounding sphere in the mesh's own space */
  center: [number, number, number];
  radius: number;
  /** a mesh fetched when the eye comes near (a building's finer levels, docs/SCENE_FORMAT.md Packed scenes): its arrays
   *  are empty until `fetch` brings them; the group draws its next level meanwhile */
  lazy?: { vertexCount: number; indexCount: number; fetch: () => Promise<MeshArrays> };
}

/** the arrays of a mesh */
export type MeshArrays = Pick<MeshData, 'positions' | 'normals' | 'tones' | 'uvs' | 'vclass' | 'patterns' | 'paint' | 'indices'>;

export interface LodLevel {
  /** the level's mesh, or its meshes (all drawn; none: nothing over this range) */
  mesh?: number;
  meshes?: number[];
  /** used up to this distance from the eye (m) */
  to: number;
}

/** the meshes of a LOD level */
export function levelMeshes(l: LodLevel): number[] { return l.meshes ?? (l.mesh !== undefined ? [l.mesh] : []); }

export interface LodGroup {
  name: string;
  levels: LodLevel[];
  /** the finest level that casts the sun's shadow (default 0): an instance drawn finer casts through this level (a
   *  tree's crown bodies, where its finest level is thin alpha-tested strands) */
  shadowFrom?: number;
  /** the sphere its level is chosen by, in the instance's space (default: its first mesh's), so every part of a
   *  building changes level together */
  bounds?: { center: [number, number, number]; radius: number };
  /** beyond this distance from the eye it casts no shadow */
  shadowTo?: number;
}

export type Batch = { mesh: number; first: number; count: number } | { lodGroup: number; first: number; count: number };

export interface Heightfield {
  origin: [number, number];
  cell: number;
  width: number;
  depth: number;
  heights: Float32Array;
  /** the class of each sample (same grid), when the ground is not all one class */
  classes?: Uint8Array;
}

export interface PathData { name: string; points: [number, number][]; halfWidth: number; slab: number; crown: number }

/** a one-channel texture (alpha masks), row-major, row 0 at v = 0 */
export interface TextureData {
  name: string;
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>;
}

export interface Viewpoint {
  id: number;
  name: string;
  position: [number, number, number];
  target: [number, number, number];
  fovY: number;
  /** fovY holds at this aspect and wider; a narrower screen widens it to keep the same horizontal field */
  fitAspect?: number;
  /** the look (SceneData.looks) it is painted in */
  look?: number;
}

/** where a walker may stand beyond the terrain (docs/SCENE_FORMAT.md, Walking) */
export interface WalkData {
  waterBelow?: number;
  /** the distance (m) a walker keeps from every blocker */
  clearance?: number;
  decks?: { origin: [number, number]; dir: [number, number]; halfWidth: number; halfLength: number; rail?: number; profile: { from: number; step: number; y: number[] } }[];
  blockers?: ({ circle: [number, number, number] } | { rect: [number, number, number, number, number] })[];
}

/** a time and season a world is painted in */
export interface LookData {
  id: number;
  name: string;
  en?: string;
  /** towards the sun (at night the moon), unit length */
  sun: [number, number, number];
  season?: 'spring' | 'summer' | 'autumn' | 'winter';
  night?: boolean;
  snow?: number;
  /** the world's own ink settings for the look (Mo's demo reads `ranges`, degrees) */
  ink?: { ranges?: number[]; [k: string]: unknown };
}

export interface SceneData {
  name: string;
  classes: Record<string, number>;
  meshes: MeshData[];
  lodGroups: LodGroup[];
  batches: Batch[];
  /** 64-byte records (docs/SCENE_FORMAT.md, instances.bin) */
  instances: ArrayBuffer;
  instanceCount: number;
  /** heightfields; `drawn: false` when the scene has its own ground meshes and the fields only carry the walker */
  terrain?: { near?: Heightfield; far?: Heightfield; cls: number; drawn?: boolean };
  water: { name: string; level: number; mesh: number }[];
  textures?: TextureData[];
  /** slab paths along centre lines (world X, Z): the ground within halfWidth and above `crown` m is paved, in courses
   *  `slab` m long */
  paths?: PathData[];
  /** towards the sun, unit length */
  sun: [number, number, number];
  viewpoints: Viewpoint[];
  looks?: LookData[];
  walk?: WalkData;
  /** the world's surface functions (WGSL defining surfaceTone(s: Surface) -> f32), compiled into the G-buffer */
  surfaces?: string;
}

export const INSTANCE_BYTES = 64;
export const CLASS_OWN = 0xffffffff;
export const FLAG_SHADOW = 1, FLAG_TWO_SIDED = 2, FLAG_WATER = 4;
/** vclass: the mesh's own class (bits 0–15), alpha-tested (bit 16) */
export const VCLASS_OWN = 0xffff, VCLASS_ALPHA = 0x10000;
/** surface patterns (docs/SCENE_FORMAT.md): the joints the G-buffer draws from a mesh's metric uv */
export const PATTERN = { NONE: 0, ASHLAR: 1, WALL: 2, CURB: 3, VAULT: 4, SLABS: 5, STEPS: 6, VOUSSOIRS: 7, BRICK: 8 } as const;
/** vclass bit 17: ground whose class is PAVE where its uv.x (a paving weight, interpolated) passes 0.5, else GROUND */
export const VCLASS_PAVE_BLEND = 0x20000;

/** the class ids the linan world uses (its src/ink/gbuffer.js CLS); a scene's own table wins */
export const CLS = {
  SKY: 0, GROUND: 1, ROCK: 2, WATER: 3, ROOF: 4, WOOD: 5, WALL: 6, STONE: 7, PINE: 8, WILLOW: 9, BROAD: 10,
  BARK: 11, FIGURE: 12, GLOW: 13, BOAT: 14, SMALL: 15, BLOSSOM: 16, WAVE: 17, MAPLE: 18, CITYFAR: 19, SNOW: 20,
  DARK: 21, METAL: 22, GINKGO: 23, LOTUS: 24, NICHE: 25, IVY: 26, PAVE: 27, BLOOM: 28, ROBE: 29,
} as const;

/** writes one instance record: a 3 × 4 affine transform by columns (X axis, Y axis, Z axis, translation) */
export function writeInstance(
  view: DataView, i: number, m: ArrayLike<number>, cls: number, seed: number, tone = 1, flags = FLAG_SHADOW,
): void {
  const o = i * INSTANCE_BYTES;
  for (let k = 0; k < 12; k++) view.setFloat32(o + k * 4, m[k], true);
  view.setUint32(o + 48, cls >>> 0, true);
  view.setUint32(o + 52, seed >>> 0, true);
  view.setFloat32(o + 56, tone, true);
  view.setUint32(o + 60, flags >>> 0, true);
}

/** the height of a heightfield at world (x, z), bilinear; NaN outside */
export function heightAt(h: Heightfield, x: number, z: number): number {
  const fx = (x - h.origin[0]) / h.cell, fz = (z - h.origin[1]) / h.cell;
  if (fx < 0 || fz < 0 || fx > h.width - 1 || fz > h.depth - 1) return NaN;
  const ix = Math.min(h.width - 2, Math.floor(fx)), iz = Math.min(h.depth - 2, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz, w = h.width, H = h.heights;
  const a = H[iz * w + ix], b = H[iz * w + ix + 1], c = H[(iz + 1) * w + ix], d = H[(iz + 1) * w + ix + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}
