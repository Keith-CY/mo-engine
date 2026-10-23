/**
 * A synthetic town for testing the engine without a world: a ground with a lake, hills around it, a causeway across
 * the lake, rows of houses (walls and hipped roofs) and some twenty thousand trees of three kinds, each a LOD group.
 * Deterministic for a seed.
 */
import { CLS, FLAG_SHADOW, FLAG_TWO_SIDED, FLAG_WATER, INSTANCE_BYTES, CLASS_OWN, writeInstance, type Heightfield, type MeshData, type SceneData } from './types';

class Builder {
  p: number[] = [];
  n: number[] = [];
  i: number[] = [];
  tri(a: number[], b: number[], c: number[]): void {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    const k = this.p.length / 3;
    for (const q of [a, b, c]) { this.p.push(q[0], q[1], q[2]); this.n.push(nx / l, ny / l, nz / l); }
    this.i.push(k, k + 1, k + 2);
  }
  quad(a: number[], b: number[], c: number[], d: number[]): void { this.tri(a, b, c); this.tri(a, c, d); }
  /** a vertex with its own normal (smooth shading) */
  vert(p: number[], n: number[]): number { this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); return this.p.length / 3 - 1; }
  mesh(name: string, cls: number, tone: number): MeshData {
    const positions = new Float32Array(this.p), normals = new Float32Array(this.n), indices = new Uint32Array(this.i);
    let cx = 0, cy = 0, cz = 0;
    const nv = positions.length / 3;
    for (let k = 0; k < nv; k++) { cx += positions[k * 3]; cy += positions[k * 3 + 1]; cz += positions[k * 3 + 2]; }
    cx /= nv; cy /= nv; cz /= nv;
    let r = 0;
    for (let k = 0; k < nv; k++) r = Math.max(r, Math.hypot(positions[k * 3] - cx, positions[k * 3 + 1] - cy, positions[k * 3 + 2] - cz));
    return { name, cls, positions, normals, tone, indices, center: [cx, cy, cz], radius: r };
  }
}

/** a unit box standing on y = 0 (x, z in −0.5 … 0.5, y in 0 … 1) */
function box(): Builder {
  const b = new Builder();
  const x0 = -0.5, x1 = 0.5, z0 = -0.5, z1 = 0.5, y0 = 0, y1 = 1;
  b.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  b.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
  b.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
  b.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
  b.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
  return b;
}

/** a hipped roof over the unit box's top: eaves at y = 0 overhanging by 0.12, ridge at y = 0.55 along x */
function hipRoof(): Builder {
  const b = new Builder();
  const o = 0.62, r = 0.28, h = 0.55;
  const A = [-o, 0, o], B = [o, 0, o], C = [o, 0, -o], D = [-o, 0, -o], R0 = [-r, h, 0], R1 = [r, h, 0];
  b.quad(A, B, R1, R0);
  b.quad(C, D, R0, R1);
  b.tri(B, C, R1);
  b.tri(D, A, R0);
  return b;
}

/** an icosphere of radius 1 subdivided `sub` times, squashed by `sy`, centred at (0, cy, 0), smooth normals */
function blob(sub: number, sy: number, cy: number, b = new Builder()): Builder {
  const t = (1 + Math.sqrt(5)) / 2;
  let V: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const cache = new Map<string, number>();
    const mid = (a: number, c: number) => {
      const k = a < c ? `${a},${c}` : `${c},${a}`;
      let m = cache.get(k);
      if (m === undefined) {
        const p = [(V[a][0] + V[c][0]) / 2, (V[a][1] + V[c][1]) / 2, (V[a][2] + V[c][2]) / 2];
        const l = Math.hypot(p[0], p[1], p[2]);
        V.push([p[0] / l, p[1] / l, p[2] / l]); m = V.length - 1; cache.set(k, m);
      }
      return m;
    };
    const F2: number[][] = [];
    for (const [a, c, d] of F) { const ab = mid(a, c), bc = mid(c, d), ca = mid(d, a); F2.push([a, ab, ca], [c, bc, ab], [d, ca, bc], [ab, bc, ca]); }
    F = F2;
  }
  const base = b.p.length / 3;
  // a little lumpiness so a crown is not a ball (fixed per vertex direction)
  V = V.map((v) => { const k = 1 + 0.12 * Math.sin(v[0] * 7.1 + v[2] * 5.3) * Math.cos(v[1] * 6.7); return [v[0] * k, v[1] * k, v[2] * k]; });
  for (const v of V) { const n = [v[0], v[1] / sy, v[2]]; const l = Math.hypot(n[0], n[1], n[2]); b.vert([v[0], v[1] * sy + cy, v[2]], [n[0] / l, n[1] / l, n[2] / l]); }
  for (const [a, c, d] of F) b.i.push(base + a, base + c, base + d);
  return b;
}

function trunk(sides: number, h: number, r: number, b = new Builder()): Builder {
  for (let s = 0; s < sides; s++) {
    const a0 = (s / sides) * Math.PI * 2, a1 = ((s + 1) / sides) * Math.PI * 2;
    const p = (a: number, y: number, rr: number) => [Math.cos(a) * rr, y, Math.sin(a) * rr];
    b.quad(p(a0, 0, r), p(a1, 0, r), p(a1, h, r * 0.6), p(a0, h, r * 0.6));
  }
  return b;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LAKE = { x: 0, z: -420, r: 380 };
function groundHeight(x: number, z: number): number {
  const dl = Math.hypot(x - LAKE.x, z - LAKE.z);
  const lake = dl < LAKE.r + 60 ? -6 * Math.min(1, (LAKE.r + 60 - dl) / 80) : 0;
  return 0.8 * Math.sin(x * 0.011) * Math.cos(z * 0.013) + lake;
}

export function syntheticTown(seed = 1103): SceneData {
  const rnd = mulberry32(seed);
  const meshes: MeshData[] = [];
  const add = (m: MeshData) => meshes.push(m) - 1;

  // the ground: a 2.4 km grid (40 m cells far, finer near the middle is not needed for a test)
  const G = new Builder();
  const S = 1200, N = 120;
  for (let iz = 0; iz <= N; iz++) for (let ix = 0; ix <= N; ix++) {
    const x = -S + (ix / N) * 2 * S, z = -S + (iz / N) * 2 * S, e = 1;
    const y = groundHeight(x, z), nx = groundHeight(x - e, z) - groundHeight(x + e, z), nz = groundHeight(x, z - e) - groundHeight(x, z + e);
    const l = Math.hypot(nx, 2 * e, nz);
    G.vert([x, y, z], [nx / l, (2 * e) / l, nz / l]);
  }
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const a = iz * (N + 1) + ix;
    G.i.push(a, a + N + 1, a + 1, a + 1, a + N + 1, a + N + 2);
  }
  const ground = add(G.mesh('ground', CLS.GROUND, 0.62));

  // the lake surface, a disc
  const W = new Builder();
  const c0 = W.vert([0, 0, 0], [0, 1, 0]);
  for (let s = 0; s <= 96; s++) { const a = (s / 96) * Math.PI * 2; W.vert([Math.cos(a) * (LAKE.r + 40), 0, Math.sin(a) * (LAKE.r + 40)], [0, 1, 0]); }
  for (let s = 0; s < 96; s++) W.i.push(c0, c0 + 2 + s, c0 + 1 + s);
  const water = add(W.mesh('lake', CLS.WATER, 0.8));

  // hills: lumpy domes 1.5 – 4 km out
  const hill = add(blob(3, 0.35, -0.1).mesh('hill', CLS.ROCK, 0.5));
  // a causeway across the lake
  const causeway = add(box().mesh('causeway', CLS.PAVE, 0.75));
  const wall = add(box().mesh('house-walls', CLS.WALL, 0.85));
  const roof = add(hipRoof().mesh('house-roof', CLS.ROOF, 0.35));
  // trees: three LOD levels each (crown + trunk, a coarser crown, a crude crown)
  const tree = (name: string, cls: number, sy: number, tone: number) => {
    const l0 = add((() => { const b = blob(2, sy, 3.2); trunk(8, 2.6, 0.22, b); return b; })().mesh(`${name}-lod0`, cls, tone));
    const l1 = add((() => { const b = blob(1, sy, 3.2); trunk(5, 2.6, 0.22, b); return b; })().mesh(`${name}-lod1`, cls, tone));
    const l2 = add(blob(0, sy, 3.2).mesh(`${name}-lod2`, cls, tone));
    return { name, levels: [{ mesh: l0, to: 60 }, { mesh: l1, to: 260 }, { mesh: l2, to: 1600 }] };
  };
  const lodGroups = [tree('broad', CLS.BROAD, 0.85, 0.32), tree('willow', CLS.WILLOW, 1.25, 0.45), tree('peach', CLS.BLOSSOM, 0.8, 0.7)];

  // instances
  type Inst = { m: number[]; cls: number; tone: number; flags: number };
  const runs: { key: { mesh: number } | { lodGroup: number }; list: Inst[] }[] = [];
  const run = (key: { mesh: number } | { lodGroup: number }) => { const r = { key, list: [] as Inst[] }; runs.push(r); return r.list; };
  const trs = (x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [c * sx, 0, -s * sx, 0, sy, 0, s * sz, 0, c * sz, x, y, z];
  };
  run({ mesh: ground }).push({ m: trs(0, 0, 0, 1, 1, 1, 0), cls: CLASS_OWN, tone: 1, flags: FLAG_SHADOW });
  run({ mesh: water }).push({ m: trs(LAKE.x, -0.6, LAKE.z, 1, 1, 1, 0), cls: CLASS_OWN, tone: 1, flags: FLAG_WATER });
  const hills = run({ mesh: hill });
  for (let k = 0; k < 28; k++) {
    const a = (k / 28) * Math.PI * 2 + rnd() * 0.2, d = 1700 + rnd() * 2300, r = 260 + rnd() * 520;
    hills.push({ m: trs(Math.sin(a) * d, -20, -Math.cos(a) * d, r, r * (0.9 + rnd() * 0.9), r, rnd() * 6), cls: CLASS_OWN, tone: 0.9 + rnd() * 0.2, flags: FLAG_SHADOW });
  }
  run({ mesh: causeway }).push({ m: trs(LAKE.x, -0.6, LAKE.z, 7, 1.4, LAKE.r * 2 + 120, 0.35), cls: CLASS_OWN, tone: 1, flags: FLAG_SHADOW });

  const walls = run({ mesh: wall }), roofs = run({ mesh: roof });
  for (let row = -6; row <= 6; row++) for (let k = 0; k < 120; k++) {
    if (rnd() < 0.22) continue;
    const x = -700 + k * 12 + rnd() * 3, z = 180 + row * 26 + rnd() * 3;
    const w = 6 + rnd() * 4, d = 7 + rnd() * 4, h = 3 + rnd() * 3.5, yaw = (rnd() - 0.5) * 0.08, y = groundHeight(x, z);
    walls.push({ m: trs(x, y, z, w, h, d, yaw), cls: CLASS_OWN, tone: 0.9 + rnd() * 0.15, flags: FLAG_SHADOW });
    roofs.push({ m: trs(x, y + h, z, w, h * 0.55 + 1.6, d, yaw), cls: CLASS_OWN, tone: 0.9 + rnd() * 0.2, flags: FLAG_SHADOW | FLAG_TWO_SIDED });
  }
  const trees = lodGroups.map((_, g) => run({ lodGroup: g }));
  for (let k = 0; k < 21000; k++) {
    const x = (rnd() * 2 - 1) * 1150, z = (rnd() * 2 - 1) * 1150;
    const dl = Math.hypot(x - LAKE.x, z - LAKE.z);
    if (dl < LAKE.r + 25) continue;
    if (z > 170 && z < 350 && x > -720 && x < 760 && rnd() < 0.9) continue; // the streets
    const kind = dl < LAKE.r + 120 ? (rnd() < 0.65 ? 1 : 2) : rnd() < 0.85 ? 0 : 2;
    const s = 0.8 + rnd() * 0.7;
    trees[kind].push({ m: trs(x, groundHeight(x, z), z, s * 2.2, s * 2, s * 2.2, rnd() * 6.3), cls: CLASS_OWN, tone: 0.85 + rnd() * 0.3, flags: FLAG_SHADOW | FLAG_TWO_SIDED });
  }

  const count = runs.reduce((n, r) => n + r.list.length, 0);
  const instances = new ArrayBuffer(count * INSTANCE_BYTES);
  const view = new DataView(instances);
  const batches: SceneData['batches'] = [];
  let i = 0;
  for (const r of runs) {
    batches.push({ ...r.key, first: i, count: r.list.length } as SceneData['batches'][number]);
    for (const it of r.list) {
      // a stable seed: the instance's origin rounded to 1 cm
      const seed = Math.imul(Math.round(it.m[9] * 100), 73856093) ^ Math.imul(Math.round(it.m[10] * 100), 19349663) ^ Math.imul(Math.round(it.m[11] * 100), 83492791);
      writeInstance(view, i++, it.m, it.cls, seed, it.tone, it.flags);
    }
  }

  // the near heightfield, for the walker's feet
  const cell = 4, width = Math.floor((2 * S) / cell) + 1;
  const heights = new Float32Array(width * width);
  for (let iz = 0; iz < width; iz++) for (let ix = 0; ix < width; ix++) heights[iz * width + ix] = groundHeight(-S + ix * cell, -S + iz * cell);
  const near: Heightfield = { origin: [-S, -S], cell, width, depth: width, heights };

  return {
    name: 'synthetic-town', classes: { ...CLS }, meshes, lodGroups, batches, instances, instanceCount: count,
    terrain: { near, cls: CLS.GROUND }, water: [{ name: 'lake', level: -0.6, mesh: water }],
    sun: normalize([0.45, 0.42, -0.79]),
    viewpoints: [
      { id: 1, name: 'causeway', position: [-40, 2.2, -120], target: [60, 4, -620], fovY: 55 },
      { id: 2, name: 'street', position: [-300, 1.7, 271], target: [200, 3, 271], fovY: 55 },
      { id: 3, name: 'hill view', position: [500, 60, 900], target: [0, 0, -300], fovY: 50 },
    ],
  };
}

function normalize(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
