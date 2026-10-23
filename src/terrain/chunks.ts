/**
 * Terrain from the scene's heightfields, drawn on the GPU: each field is a texture (src/render/renderer.ts uploads
 * them) and the ground is a few shared grid meshes on the unit square, one per level of detail (cells coarser and
 * coarser), with skirts hanging down along every edge to hide the cracks where neighbours sit at different levels.
 * Each chunk of a field is one instance of the field's LOD group, so the chunks go through the same culling and
 * distance-only LOD as everything else; the vertex shaders lift every grid vertex to the field's height there and take
 * its normal from the field (src/shaders/terrain.wgsl). A city's terrain then costs its textures and a few thousand
 * instances, not millions of vertices.
 *
 * The far field gives way where the near field lies: its vertices there sink under it.
 */
import { FLAG_SHADOW, INSTANCE_BYTES, CLASS_OWN, VCLASS_OWN, VCLASS_PAVE_BLEND, heightAt, writeInstance, type Heightfield, type MeshData, type SceneData } from '../scene/types';

/** vclass bits of terrain vertices: lifted to a field (18), the far field (19), a skirt vertex (20) */
export const VCLASS_TERRAIN = 1 << 18, VCLASS_FAR = 1 << 19, VCLASS_SKIRT = 1 << 20;

/** a grid of n × n cells on the unit square (x, z), its skirt ring after it; uv.x carries n (the shaders' cell size) */
function gridMesh(name: string, n: number, cls: number, tone: number, bits: number): MeshData {
  const pos: number[] = [], vcls: number[] = [], uvs: number[] = [], idx: number[] = [];
  const vert = (i: number, k: number, skirt: boolean) => {
    pos.push(i / n, 0, k / n);
    vcls.push(VCLASS_OWN | bits | (skirt ? VCLASS_SKIRT : 0));
    uvs.push(n, 0);
    return pos.length / 3 - 1;
  };
  for (let k = 0; k <= n; k++) for (let i = 0; i <= n; i++) vert(i, k, false);
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
    const a = k * (n + 1) + i, b = a + 1, d = a + n + 1, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const edge = (cells: [number, number][]) => {
    let prevTop = -1, prevLow = -1;
    for (const [i, k] of cells) {
      const top = k * (n + 1) + i, low = vert(i, k, true);
      if (prevTop >= 0) idx.push(prevTop, prevLow, top, top, prevLow, low);
      prevTop = top; prevLow = low;
    }
  };
  edge(Array.from({ length: n + 1 }, (_, i) => [i, 0] as [number, number]));
  edge(Array.from({ length: n + 1 }, (_, i) => [n - i, n] as [number, number]));
  edge(Array.from({ length: n + 1 }, (_, k) => [0, n - k] as [number, number]));
  edge(Array.from({ length: n + 1 }, (_, k) => [n, k] as [number, number]));
  const nv = pos.length / 3;
  const normals = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) normals[v * 3 + 1] = 1;
  return {
    name, cls, positions: new Float32Array(pos), normals, tone, indices: new Uint32Array(idx),
    vclass: new Uint32Array(vcls), uvs: new Float32Array(uvs), center: [0.5, 0, 0.5], radius: 1,
  };
}

/** adds the terrain of `scene.terrain` to the scene: per field a LOD group of grids and an instance per chunk */
export function addTerrain(scene: SceneData, tone = 0.62): SceneData {
  const t = scene.terrain;
  if (!t) return scene;
  const added: { group: number; m: number[] }[] = [];
  const plan = (f: Heightfield, far: boolean) => {
    // 64 cells a chunk; the levels' grids 64, 16 and 4 cells a side, used up to a few chunk spans
    const N = 64, span = f.cell * N;
    const to = far ? [span * 1.5, span * 6, 1e6] : [span * 1.2, span * 5, 1e5];
    const bits = VCLASS_TERRAIN | (far ? VCLASS_FAR : 0) | (!far && f.classes ? VCLASS_PAVE_BLEND : 0);
    const levels = [N, 16, 4].map((n, li) => ({ mesh: scene.meshes.push(gridMesh(`terrain ${far ? 'far' : 'near'} /${N / n}`, n, t.cls, tone, bits)) - 1, to: to[li] }));
    // (bounds in the instance's space: the chunk's centre; its radius is the instance's largest axis, below)
    const group = scene.lodGroups.push({ name: `terrain ${far ? 'far' : 'near'}`, levels, bounds: { center: [0.5, 0, 0.5], radius: 1 } }) - 1;
    const nx = Math.ceil((f.width - 1) / N), nz = Math.ceil((f.depth - 1) / N);
    const list: number[] = [];
    for (let cz = 0; cz < nz; cz++) for (let cx = 0; cx < nx; cx++) {
      const i0 = cx * N, k0 = cz * N;
      let lo = Infinity, hi = -Infinity;
      for (let k = k0; k <= Math.min(f.depth - 1, k0 + N); k += 2) for (let i = i0; i <= Math.min(f.width - 1, i0 + N); i += 2) {
        const h = f.heights[k * f.width + i];
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      if (!(hi >= lo)) continue;
      const x0 = f.origin[0] + i0 * f.cell, z0 = f.origin[1] + k0 * f.cell;
      // the Y axis (unused by the lifted vertices) sets the culling radius: the chunk's half diagonal and half height
      const r = Math.max(span, Math.hypot(span * 0.71, (hi - lo) / 2 + 2));
      list.push(x0, (lo + hi) / 2, z0, span, r);
    }
    added.push({ group, m: list });
  };
  if (t.near) plan(t.near, false);
  if (t.far) plan(t.far, true);
  const n = added.reduce((s, a) => s + a.m.length / 5, 0);
  const old = scene.instanceCount, count = old + n;
  const buf = new ArrayBuffer(count * INSTANCE_BYTES);
  new Uint8Array(buf).set(new Uint8Array(scene.instances, 0, old * INSTANCE_BYTES));
  const view = new DataView(buf);
  let k = old;
  for (const a of added) {
    const first = k;
    for (let j = 0; j < a.m.length; j += 5) {
      const [x, y, z, s, r] = a.m.slice(j, j + 5);
      writeInstance(view, k, [s, 0, 0, 0, r, 0, 0, 0, s, x, y, z], CLASS_OWN, (0x7e44a1 ^ Math.imul(k, 2654435761)) >>> 0, 1, FLAG_SHADOW);
      k++;
    }
    if (k > first) scene.batches.push({ lodGroup: a.group, first, count: k - first });
  }
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
