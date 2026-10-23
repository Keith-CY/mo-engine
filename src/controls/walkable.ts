/**
 * Where a walker may stand (docs/SCENE_FORMAT.md, Walking): the terrain, or a bridge deck where it is higher; water
 * (ground below `waterBelow` with no deck) and blockers (buildings, houses, rocks, pagodas) stop the walker at their
 * edge, and so does a step up of more than `maxStep` (a terrace face, a wall of rock).
 */
import type { SceneData, WalkData } from '../scene/types';
import { groundAt } from '../terrain/chunks';

const CELL = 32;

interface Deck { ox: number; oz: number; dx: number; dz: number; hw: number; hl: number; rail: number; from: number; step: number; y: number[] }
type Blocker = { c: [number, number, number] } | { r: [number, number, number, number, number] };

export class Walkable {
  /** the highest step a walker takes (m) */
  maxStep = 1.2;
  private readonly decks: Deck[] = [];
  private readonly blockers: Blocker[] = [];
  private readonly grid = new Map<number, { decks: number[]; blockers: number[] }>();
  private readonly waterBelow: number;

  constructor(private readonly scene: SceneData) {
    const w: WalkData = scene.walk ?? {};
    this.waterBelow = w.waterBelow ?? -Infinity;
    for (const d of w.decks ?? []) {
      const l = Math.hypot(d.dir[0], d.dir[1]) || 1;
      const dk: Deck = { ox: d.origin[0], oz: d.origin[1], dx: d.dir[0] / l, dz: d.dir[1] / l, hw: d.halfWidth, hl: d.halfLength, rail: d.rail ?? 0.45, from: d.profile.from, step: d.profile.step, y: d.profile.y };
      const k = this.decks.push(dk) - 1;
      this.index(dk.ox, dk.oz, Math.hypot(dk.hw, dk.hl) + 1, (c) => c.decks.push(k));
    }
    for (const b of w.blockers ?? []) {
      const k = this.blockers.push('circle' in b ? { c: b.circle } : { r: b.rect }) - 1;
      if ('circle' in b) this.index(b.circle[0], b.circle[1], b.circle[2], (c) => c.blockers.push(k));
      else this.index(b.rect[0], b.rect[1], Math.hypot(b.rect[2], b.rect[3]), (c) => c.blockers.push(k));
    }
  }

  private key(ix: number, iz: number): number { return ix * 73856093 ^ iz * 19349663; }
  private index(x: number, z: number, r: number, add: (c: { decks: number[]; blockers: number[] }) => void): void {
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const k = this.key(ix, iz);
        let c = this.grid.get(k);
        if (!c) this.grid.set(k, (c = { decks: [], blockers: [] }));
        add(c);
      }
    }
  }
  private cell(x: number, z: number) { return this.grid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL))); }

  /** the highest deck under (x, z), −Infinity off every deck (or on its rail) */
  deckAt(x: number, z: number): number {
    let best = -Infinity;
    for (const k of this.cell(x, z)?.decks ?? []) {
      const d = this.decks[k];
      const rx = x - d.ox, rz = z - d.oz;
      const along = rx * d.dx + rz * d.dz, across = rx * d.dz - rz * d.dx;
      if (Math.abs(along) > d.hl || Math.abs(across) > d.hw - d.rail) continue;
      const t = Math.max(0, Math.min(d.y.length - 1, (along - d.from) / d.step));
      const i = Math.min(d.y.length - 2, Math.floor(t)), f = t - i;
      best = Math.max(best, d.y.length > 1 ? d.y[i] * (1 - f) + d.y[i + 1] * f : d.y[0]);
    }
    return best;
  }

  /** the ground a walker stands on at (x, z): the terrain or a deck, whichever is higher (NaN: none) */
  groundAt(x: number, z: number): number {
    const t = groundAt(this.scene, x, z), d = this.deckAt(x, z);
    return Number.isFinite(t) ? Math.max(t, d) : Number.isFinite(d) ? d : NaN;
  }

  /** may a walker stand at (x, z), coming from ground height `fromG`? */
  free(x: number, z: number, fromG?: number): boolean {
    const t = groundAt(this.scene, x, z), d = this.deckAt(x, z);
    const g = Math.max(Number.isFinite(t) ? t : -Infinity, d);
    if (d === -Infinity && !(t >= this.waterBelow)) return false;
    if (fromG !== undefined && g - fromG > this.maxStep) return false;
    if (d === -Infinity) {
      for (const k of this.cell(x, z)?.blockers ?? []) {
        const b = this.blockers[k];
        if ('c' in b) { if (Math.hypot(x - b.c[0], z - b.c[1]) < b.c[2] + 0.35) return false; }
        else {
          const [cx, cz, hw, hd, rot] = b.r, s = Math.sin(rot), c = Math.cos(rot);
          const lx = (x - cx) * c - (z - cz) * s, lz = (x - cx) * s + (z - cz) * c;
          if (Math.abs(lx) < hw + 0.35 && Math.abs(lz) < hd + 0.35) return false;
        }
      }
    }
    return true;
  }
}
