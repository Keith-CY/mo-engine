/**
 * A modelled water surface: within a region the flat water plane gives way to a grid lifted on the GPU by short crested
 * waves and, optionally, a breaking front (a bore) standing across the water (src/shaders/water.wgsl). The front is the
 * water itself rising — its face, its crest and the raised churned water behind it one surface with the sea about it —
 * so the painter shades a wall that grows out of the waves, not a wall set down on a sheet of paper.
 *
 * The grid is the terrain's (src/terrain/chunks.ts): shared grid meshes on the unit square, one instance per chunk, a
 * LOD group per cell size. Chunks within the front's band are a quarter the size (cells of `FINE` m: the face is a few
 * metres across), the rest of the region `COARSE` m cells; skirts hide the cracks where they meet.
 */
import { CLS, FLAG_WATER, INSTANCE_BYTES, CLASS_OWN, writeInstance, type SceneData, type WaterSurface } from '../scene/types';
import { gridMesh } from '../terrain/chunks';

/** vclass bit 21: a water grid vertex, lifted onto the modelled surface */
export const VCLASS_WATER = 1 << 21;
const N = 64, FINE = 0.75, COARSE = 3;
/** the front's band (m behind it, m ahead of it): the raised water behind the crest runs about 160 / 16 of its height */
const BAND: [number, number] = [-170, 60];

/** the front's frame on the CPU, as water.wgsl computes it: (m along it from a, m ahead of its crest line) */
export function frontFrame(f: NonNullable<WaterSurface['front']>): (x: number, z: number) => [number, number] {
  const len = Math.max(1, Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]));
  const tx = (f.b[0] - f.a[0]) / len, tz = (f.b[1] - f.a[1]) / len;
  let nx = -tz, nz = tx;
  if ((f.toward[0] - f.a[0]) * nx + (f.toward[1] - f.a[1]) * nz < 0) { nx = -nx; nz = -nz; }
  const bow = (al: number) => {
    const u = Math.min(1, Math.max(0, al / len));
    return f.bow * (Math.sin(Math.PI * u) + 0.3 * Math.sin(3 * Math.PI * u + 0.8) - 0.3 * Math.sin(0.8) * (1 - u) - 0.3 * Math.sin(3 * Math.PI + 0.8) * u);
  };
  return (x, z) => { const al = (x - f.a[0]) * tx + (z - f.a[1]) * tz; return [al, (x - f.a[0]) * nx + (z - f.a[1]) * nz - bow(al)]; };
}

/** the modelled surface's uniforms (src/shaders/frame.wgsl waterA … waterE; all 0: none) */
export function waterUniforms(scene: SceneData, look = -1): Float32Array {
  const u = new Float32Array(20);
  const w = scene.water.find((x) => x.surface);
  const s = w?.surface;
  if (!w || !s || (s.looks && !s.looks.includes(look))) return u;
  const wv = s.waves ?? [0.3, 14, 1.2, 400];
  u.set(s.region, 0);
  u.set([w.level, wv[0], wv[1], 1], 4);
  const f = s.front;
  if (f) {
    const len = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]);
    let nx = -(f.b[1] - f.a[1]) / len, nz = (f.b[0] - f.a[0]) / len;
    if ((f.toward[0] - f.a[0]) * nx + (f.toward[1] - f.a[1]) * nz < 0) { nx = -nx; nz = -nz; }
    u.set([f.a[0], f.a[1], f.b[0], f.b[1]], 8);
    u.set([f.height[0], f.height[1], f.period, f.bow], 12);
    u.set([nx, nz, wv[2], wv[3]], 16);
  } else u.set([0, 0, wv[0], 1], 16);
  return u;
}

/** adds the grid of the scene's modelled water surface (the first water with a `surface`) */
export function addWaterSurface(scene: SceneData): SceneData {
  const w = scene.water.find((x) => x.surface);
  const s = w?.surface;
  if (!w || !s) return scene;
  const cls = scene.classes.WATER ?? CLS.WATER;
  const fr = s.front ? frontFrame(s.front) : undefined;
  const hMax = s.front ? Math.max(...s.front.height) * 1.2 : 0;
  const lenF = s.front ? Math.hypot(s.front.b[0] - s.front.a[0], s.front.b[1] - s.front.a[1]) : 0;
  const inBand = (x: number, z: number) => {
    if (!fr) return false;
    const [al, sd] = fr(x, z);
    return sd > BAND[0] && sd < BAND[1] && al > -40 && al < lenF + 40;
  };
  const group = (name: string, to: number[]) => {
    const levels = [N, 16, 4].map((n, li) => ({ mesh: scene.meshes.push({ ...gridMesh(`water ${name} /${N / n}`, n, cls, 1, VCLASS_WATER), looks: s.looks }) - 1, to: to[li] }));
    return scene.lodGroups.push({ name: `water ${name}`, levels, bounds: { center: [0.5, 0, 0.5], radius: 1 } }) - 1;
  };
  const gFine = group('fine', [1700, 4000, 1e5]), gCoarse = group('coarse', [1500, 4000, 1e5]);
  const fine: number[] = [], coarse: number[] = [];
  const [x0, z0, x1, z1] = s.region, S = N * COARSE, sf = N * FINE;
  for (let z = z0; z < z1; z += S) for (let x = x0; x < x1; x += S) {
    // a coarse tile the front's band touches is laid in fine chunks
    let touch = false;
    for (let k = 0; k <= 8 && !touch; k++) for (let i = 0; i <= 8 && !touch; i++) touch = inBand(x + (S * i) / 8, z + (S * k) / 8);
    if (!touch) { coarse.push(x, z, S, 0); continue; }
    for (let zz = z; zz < z + S - 1e-6; zz += sf) for (let xx = x; xx < x + S - 1e-6; xx += sf) {
      let t = false;
      for (let k = 0; k <= 2 && !t; k++) for (let i = 0; i <= 2 && !t; i++) t = inBand(xx + (sf * i) / 2, zz + (sf * k) / 2);
      fine.push(xx, zz, sf, t ? hMax : 0);
    }
  }
  const old = scene.instanceCount, count = old + (fine.length + coarse.length) / 4;
  const buf = new ArrayBuffer(count * INSTANCE_BYTES);
  new Uint8Array(buf).set(new Uint8Array(scene.instances, 0, old * INSTANCE_BYTES));
  const view = new DataView(buf);
  let k = old;
  for (const [g, list] of [[gFine, fine], [gCoarse, coarse]] as const) {
    const first = k;
    for (let j = 0; j < list.length; j += 4) {
      const [x, z, sp, h] = list.slice(j, j + 4);
      // (the Y axis, unused by the lifted vertices, sets the culling radius: the chunk's half diagonal and its waves)
      const r = Math.hypot(sp * 0.71, h / 2 + 3);
      writeInstance(view, k, [sp, 0, 0, 0, r, 0, 0, 0, sp, x, w.level + h / 2, z], CLASS_OWN, (0x3a7e11 ^ Math.imul(k, 2654435761)) >>> 0, 1, FLAG_WATER);
      k++;
    }
    if (k > first) scene.batches.push({ lodGroup: g, first, count: k - first });
  }
  scene.instances = buf;
  scene.instanceCount = count;
  return scene;
}
