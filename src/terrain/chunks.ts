/**
 * Terrain from the scene's heightfields as chunks: each chunk is a LOD group of grids with coarser and coarser cells,
 * with skirts (a strip hanging down along every edge) hiding the cracks where neighbours sit at different levels.
 * Chunks are ordinary instances, so they go through the same culling and distance-only LOD as everything else.
 *
 * The far field is cut where the near field lies (its triangles there would fight with the near ones).
 */
import { FLAG_SHADOW, INSTANCE_BYTES, CLASS_OWN, VCLASS_OWN, heightAt, writeInstance, type Heightfield, type MeshData, type SceneData } from '../scene/types';

interface FieldPlan {
  field: Heightfield;
  /** cells per chunk side */
  chunk: number;
  /** each level's step (cells) and the distance it is used up to (m) */
  levels: { step: number; to: number }[];
  /** world XZ box whose triangles are left out (the near field, for the far one) */
  hole?: [number, number, number, number];
}

function chunkMesh(p: FieldPlan, cx: number, cz: number, step: number, cls: number, tone: number): MeshData | null {
  const f = p.field, c = f.cell;
  const i0 = cx * p.chunk, k0 = cz * p.chunk;
  const n = Math.floor(Math.min(p.chunk, f.width - 1 - i0) / step), m = Math.floor(Math.min(p.chunk, f.depth - 1 - k0) / step);
  if (n < 1 || m < 1) return null;
  const ox = f.origin[0] + i0 * c, oz = f.origin[1] + k0 * c;
  const H = (i: number, k: number) => f.heights[Math.min(f.depth - 1, k) * f.width + Math.min(f.width - 1, i)];
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [], vcls: number[] = [];
  const C = f.classes;
  const vert = (i: number, k: number, drop: number) => {
    const gi = i0 + i * step, gk = k0 + k * step;
    const h = H(gi, gk);
    const dx = H(Math.max(0, gi - 1), gk) - H(gi + 1, gk), dz = H(gi, Math.max(0, gk - 1)) - H(gi, gk + 1);
    const l = Math.hypot(dx, 2 * c, dz);
    pos.push(gi * c + f.origin[0] - ox, h - drop, gk * c + f.origin[1] - oz);
    nrm.push(dx / l, (2 * c) / l, dz / l);
    // (the class of the sample: paving where the field says so)
    vcls.push(C ? C[Math.min(f.depth - 1, gk) * f.width + Math.min(f.width - 1, gi)] : VCLASS_OWN);
    return pos.length / 3 - 1;
  };
  const grid: number[] = [];
  for (let k = 0; k <= m; k++) for (let i = 0; i <= n; i++) grid.push(vert(i, k, 0));
  const inHole = (i: number, k: number) => {
    if (!p.hole) return false;
    const x = ox + (i + 0.5) * step * c, z = oz + (k + 0.5) * step * c;
    return x > p.hole[0] && x < p.hole[2] && z > p.hole[1] && z < p.hole[3];
  };
  for (let k = 0; k < m; k++) for (let i = 0; i < n; i++) {
    if (inHole(i, k)) continue;
    const a = grid[k * (n + 1) + i], b = a + 1, d = grid[(k + 1) * (n + 1) + i], e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  if (!idx.length) return null;
  // skirts: each edge's vertices again, dropped by a few cells' worth, joined to the edge
  const drop = 2 + step * c * 0.5;
  const edge = (cells: [number, number][]) => {
    let prevTop = -1, prevLow = -1;
    for (const [i, k] of cells) {
      const top = grid[k * (n + 1) + i], low = vert(i, k, drop);
      if (prevTop >= 0) idx.push(prevTop, prevLow, top, top, prevLow, low);
      prevTop = top; prevLow = low;
    }
  };
  edge(Array.from({ length: n + 1 }, (_, i) => [i, 0] as [number, number]));
  edge(Array.from({ length: n + 1 }, (_, i) => [n - i, m] as [number, number]));
  edge(Array.from({ length: m + 1 }, (_, k) => [0, m - k] as [number, number]));
  edge(Array.from({ length: m + 1 }, (_, k) => [n, k] as [number, number]));
  const positions = new Float32Array(pos);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < positions.length; v += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], positions[v + a]); hi[a] = Math.max(hi[a], positions[v + a]); }
  const center: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return {
    name: `terrain ${cx},${cz} /${step}`, cls, positions, normals: new Float32Array(nrm), tone, indices: new Uint32Array(idx),
    vclass: C ? new Uint32Array(vcls) : undefined,
    center, radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2,
  };
}

/** adds the terrain of `scene.terrain` to the scene as chunked LOD meshes (returns the same scene) */
export function addTerrain(scene: SceneData, tone = 0.62): SceneData {
  const t = scene.terrain;
  if (!t) return scene;
  const plans: FieldPlan[] = [];
  // chunks big enough that a field makes at most ~300 of them (each chunk level is one draw per pass)
  const chunkFor = (f: Heightfield, min: number) => Math.max(min, 2 ** Math.ceil(Math.log2(Math.sqrt((f.width * f.depth) / 300))));
  if (t.near) {
    const chunk = chunkFor(t.near, 128), span = t.near.cell * chunk;
    plans.push({ field: t.near, chunk, levels: [{ step: 1, to: span * 1.2 }, { step: 4, to: span * 5 }, { step: 16, to: 1e5 }] });
  }
  if (t.far) {
    const chunk = chunkFor(t.far, 64), span = t.far.cell * chunk;
    const n = t.near;
    const hole: FieldPlan['hole'] = n ? [n.origin[0] + n.cell, n.origin[1] + n.cell, n.origin[0] + (n.width - 2) * n.cell, n.origin[1] + (n.depth - 2) * n.cell] : undefined;
    plans.push({ field: t.far, chunk, levels: [{ step: 1, to: span * 1.5 }, { step: 4, to: span * 6 }, { step: 16, to: 1e6 }], hole });
  }
  const added: { group: number; x: number; y: number; z: number }[] = [];
  for (const p of plans) {
    const f = p.field;
    const nx = Math.ceil((f.width - 1) / p.chunk), nz = Math.ceil((f.depth - 1) / p.chunk);
    for (let cz = 0; cz < nz; cz++) for (let cx = 0; cx < nx; cx++) {
      const levels: { mesh: number; to: number }[] = [];
      for (const l of p.levels) {
        const m = chunkMesh(p, cx, cz, l.step, t.cls, tone);
        if (!m) break;
        levels.push({ mesh: scene.meshes.push(m) - 1, to: l.to });
      }
      if (!levels.length) continue;
      const group = scene.lodGroups.push({ name: `terrain ${cx},${cz}`, levels }) - 1;
      added.push({ group, x: f.origin[0] + cx * p.chunk * f.cell, y: 0, z: f.origin[1] + cz * p.chunk * f.cell });
    }
  }
  // the chunks' instances, after the scene's own
  const old = scene.instanceCount, count = old + added.length;
  const buf = new ArrayBuffer(count * INSTANCE_BYTES);
  new Uint8Array(buf).set(new Uint8Array(scene.instances, 0, old * INSTANCE_BYTES));
  const view = new DataView(buf);
  added.forEach((a, k) => {
    writeInstance(view, old + k, [1, 0, 0, 0, 1, 0, 0, 0, 1, a.x, a.y, a.z], CLASS_OWN, (0x7e44a1 ^ Math.imul(a.group, 2654435761)) >>> 0, 1, FLAG_SHADOW);
    scene.batches.push({ lodGroup: a.group, first: old + k, count: 1 });
  });
  scene.instances = buf;
  scene.instanceCount = count;
  return scene;
}

/** the ground height at (x, z): the near field, else the far one */
export function groundAt(scene: SceneData, x: number, z: number): number {
  const t = scene.terrain;
  const h = t?.near ? heightAt(t.near, x, z) : NaN;
  return Number.isFinite(h) ? h : t?.far ? heightAt(t.far, x, z) : NaN;
}
