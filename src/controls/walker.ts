/**
 * First-person controller: walk (feet on the ground), run, fly — at linan's speeds (a city 9 km across: walking 5 m/s,
 * running 16, flying 40, fast 220). Mouse look is raw — no smoothing, no acceleration — with the pointer locked
 * (double-click), or by dragging. Translation eases in and out; walking, the eye follows the ground's steps smoothly;
 * there is no head-bob. A viewpoint's pose is held exactly (pin) until the walker moves.
 *   W A S D / arrows  move · Shift  run · F  walk / fly · Space / E, C / Q  up / down (flying)
 * Touch: the left of the screen steers (a stick under the thumb, pushed to its rim it runs), the right looks; `lift`
 * (−1, 0, 1) is up / down for the page's buttons while flying, `onStick` draws the stick.
 */
import type { Camera } from '../core/camera';

export class Walker {
  mode: 'walk' | 'fly' = 'walk';
  eyeHeight = 1.6;
  walkSpeed = 5;
  runSpeed = 16;
  flySpeed = 40;
  flyRunSpeed = 220;
  /** flying stays this far above the ground (or the water), and at most flyCeiling over it (a painting seen from too
   *  high dissolves into mist) */
  flyFloor = 1.5;
  flyCeiling = 700;
  /** radians per pixel of mouse movement with the pointer locked, while dragging, and of a finger on the right */
  lockedSensitivity = 0.0022;
  dragSensitivity = 0.004;
  touchSensitivity = 0.006;
  /** the ground under (x, z), for walking (NaN: none) */
  ground: (x: number, z: number) => number = () => 0;
  /** may a walker step to (x, z) from ground height fromG? (water, buildings, a wall of rock stop it) */
  free: (x: number, z: number, fromG?: number) => boolean = () => true;
  readonly keys = new Set<string>();
  /** touch input: the stick (−1…1 each way, y forward) and up / down */
  readonly stick = { x: 0, y: 0 };
  lift = 0;
  /** the touch stick, appearing where the thumb landed (x, y) and pushed by (dx, dy) px; null when it lets go */
  onStick: (s: { x: number; y: number; dx: number; dy: number } | null) => void = () => {};
  private vel: [number, number, number] = [0, 0, 0];
  private drag: { x: number; y: number } | null = null;
  private eyeY: number | null = null;
  private pinned = false;
  private detach: () => void = () => {};

  constructor(private readonly camera: Camera) {}

  attach(el: HTMLElement): void {
    const typing = (e: Event) => /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement | null)?.tagName ?? '');
    const onKey = (e: KeyboardEvent, down: boolean) => {
      if (down && typing(e)) return;
      if (down && (e.code.startsWith('Arrow') || e.code === 'Space')) e.preventDefault();
      if (e.repeat) return;
      if (down && e.code === 'KeyF') this.mode = this.mode === 'walk' ? 'fly' : 'walk';
      if (down) this.keys.add(e.code); else this.keys.delete(e.code);
    };
    const kd = (e: KeyboardEvent) => onKey(e, true), ku = (e: KeyboardEvent) => onKey(e, false);
    const md = (e: MouseEvent) => { if (document.pointerLockElement !== el) this.drag = { x: e.clientX, y: e.clientY }; };
    const mu = () => { this.drag = null; };
    const mm = (e: MouseEvent) => {
      if (document.pointerLockElement === el) this.look(e.movementX * this.lockedSensitivity, e.movementY * this.lockedSensitivity);
      else if (this.drag) {
        this.look((e.clientX - this.drag.x) * this.dragSensitivity, (e.clientY - this.drag.y) * this.dragSensitivity);
        this.drag = { x: e.clientX, y: e.clientY };
      }
    };
    const dbl = () => el.requestPointerLock?.();
    const blur = () => { this.keys.clear(); this.stick.x = this.stick.y = 0; this.lift = 0; };
    // touch: a finger landing on the left 45 % steers (one stick at a time), any other looks
    const R = 56;
    const touches = new Map<number, { stick: boolean; x0: number; y0: number; x: number; y: number }>();
    const ts = (e: TouchEvent) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        const stick = t.clientX < innerWidth * 0.45 && ![...touches.values()].some((s) => s.stick);
        touches.set(t.identifier, { stick, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY });
        if (stick) this.onStick({ x: t.clientX, y: t.clientY, dx: 0, dy: 0 });
      }
    };
    const tm = (e: TouchEvent) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        const s = touches.get(t.identifier); if (!s) continue;
        if (!s.stick) {
          this.look((t.clientX - s.x) * this.touchSensitivity, (t.clientY - s.y) * this.touchSensitivity);
          s.x = t.clientX; s.y = t.clientY;
          continue;
        }
        const dx = t.clientX - s.x0, dy = t.clientY - s.y0, l = Math.hypot(dx, dy), k = l > R ? R / l : 1;
        this.stick.x = (dx * k) / R; this.stick.y = (-dy * k) / R;
        this.onStick({ x: s.x0, y: s.y0, dx: dx * k, dy: dy * k });
      }
    };
    const te = (e: TouchEvent) => {
      for (const t of e.changedTouches) {
        const s = touches.get(t.identifier); touches.delete(t.identifier);
        if (s?.stick) { this.stick.x = this.stick.y = 0; this.onStick(null); }
      }
    };
    addEventListener('keydown', kd); addEventListener('keyup', ku); addEventListener('blur', blur);
    el.addEventListener('mousedown', md); addEventListener('mouseup', mu); addEventListener('mousemove', mm); el.addEventListener('dblclick', dbl);
    el.addEventListener('touchstart', ts, { passive: false }); el.addEventListener('touchmove', tm, { passive: false });
    el.addEventListener('touchend', te); el.addEventListener('touchcancel', te);
    this.detach = () => {
      removeEventListener('keydown', kd); removeEventListener('keyup', ku); removeEventListener('blur', blur);
      el.removeEventListener('mousedown', md); removeEventListener('mouseup', mu); removeEventListener('mousemove', mm); el.removeEventListener('dblclick', dbl);
      el.removeEventListener('touchstart', ts); el.removeEventListener('touchmove', tm);
      el.removeEventListener('touchend', te); el.removeEventListener('touchcancel', te);
    };
  }

  dispose(): void { this.detach(); }

  /** hold the camera's position exactly (a viewpoint), off the ground rules, until the walker moves */
  pin(): void {
    this.pinned = true;
    this.vel = [0, 0, 0];
    this.eyeY = null;
  }

  /** turn by (dx, dy) radians: right and down positive */
  look(dx: number, dy: number): void {
    this.camera.yaw += dx;
    this.camera.pitch = Math.max(-1.45, Math.min(1.45, this.camera.pitch - dy));
  }

  /** one frame of movement; true when the eye moved */
  update(dt: number): boolean {
    const k = this.keys, c = this.camera;
    let fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + this.stick.y;
    let side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + this.stick.x;
    const fly = this.mode === 'fly';
    const up = fly ? (k.has('Space') || k.has('KeyE') ? 1 : 0) - (k.has('KeyC') || k.has('KeyQ') ? 1 : 0) + this.lift : 0;
    if (this.pinned) {
      if (!fwd && !side && !up) return false;
      // (off the viewpoint: the eye eases from the viewpoint's height to the ground's)
      this.pinned = false;
    }
    const run = k.has('ShiftLeft') || k.has('ShiftRight') || Math.hypot(this.stick.x, this.stick.y) > 0.97;
    const speed = fly ? (run ? this.flyRunSpeed : this.flySpeed) : run ? this.runSpeed : this.walkSpeed;
    const len = Math.hypot(fwd, side);
    if (len > 1) { fwd /= len; side /= len; }
    const f = c.forward(), r = c.right();
    // walking moves along the ground's plane; flying along the view
    const fx = fly ? f : [Math.sin(c.yaw), 0, -Math.cos(c.yaw)];
    const target = [0, 1, 2].map((i) => (fx[i] * fwd + r[i] * side + (i === 1 ? up : 0)) * speed);
    // (flying eases in and out more slowly: at 220 m/s a sudden start is a jolt)
    const a = 1 - Math.exp(-dt * (fly ? 4 : 9));
    for (let i = 0; i < 3; i++) this.vel[i] += (target[i] - this.vel[i]) * a;
    if (Math.hypot(...this.vel) < 0.01 && !fwd && !side && !up) this.vel = [0, 0, 0];
    const p = c.position;
    const before = p.join();
    if (!fly) {
      // a blocked step slides along whichever axis is still free (along a wall or the water's edge)
      const g0 = this.ground(p[0], p[2]);
      const nx = p[0] + this.vel[0] * dt, nz = p[2] + this.vel[2] * dt;
      if (this.free(nx, nz, g0)) { p[0] = nx; p[2] = nz; }
      else if (this.free(nx, p[2], g0)) { p[0] = nx; this.vel[2] = 0; }
      else if (this.free(p[0], nz, g0)) { p[2] = nz; this.vel[0] = 0; }
      else { this.vel[0] = 0; this.vel[2] = 0; }
      const g = this.ground(p[0], p[2]);
      if (Number.isFinite(g)) {
        // the eye follows steps and deck slabs smoothly, but never sinks into the ground
        const want = g + this.eyeHeight;
        this.eyeY = this.eyeY === null ? p[1] : this.eyeY + (want - this.eyeY) * (1 - Math.exp(-dt * 12));
        if (this.eyeY < want - 0.25) this.eyeY = want - 0.25;
        p[1] = this.eyeY;
      }
    } else {
      p[0] += this.vel[0] * dt; p[1] += this.vel[1] * dt; p[2] += this.vel[2] * dt;
      this.eyeY = null;
      const g = this.ground(p[0], p[2]);
      if (Number.isFinite(g)) {
        const base = Math.max(g, 0);
        p[1] = Math.min(Math.max(p[1], base + this.flyFloor), Math.max(p[1] - this.vel[1] * dt, base + this.flyCeiling));
      }
    }
    return p.join() !== before;
  }
}
