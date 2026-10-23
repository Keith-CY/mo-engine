/**
 * First-person controller: walk (feet on the ground), run, fly. Mouse look is raw — no smoothing, no acceleration —
 * with the pointer locked (click), or by dragging. Translation eases in and out; there is no head-bob.
 *   W A S D  move · Shift  run · F  walk / fly · Space / C  up / down (flying)
 */
import type { Camera } from '../core/camera';

export class Walker {
  mode: 'walk' | 'fly' = 'walk';
  eyeHeight = 1.6;
  walkSpeed = 1.8;
  runSpeed = 5.5;
  flySpeed = 18;
  flyRunSpeed = 60;
  /** radians per pixel of mouse movement with the pointer locked, and while dragging */
  lockedSensitivity = 0.0022;
  dragSensitivity = 0.004;
  /** the ground under (x, z), for walking (NaN: none) */
  ground: (x: number, z: number) => number = () => 0;
  /** may a walker step to (x, z) from ground height fromG? (water, buildings, a wall of rock stop it) */
  free: (x: number, z: number, fromG?: number) => boolean = () => true;
  readonly keys = new Set<string>();
  private vel: [number, number, number] = [0, 0, 0];
  private drag: { x: number; y: number } | null = null;
  private detach: () => void = () => {};

  constructor(private readonly camera: Camera) {}

  attach(el: HTMLElement): void {
    const onKey = (e: KeyboardEvent, down: boolean) => {
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
    const blur = () => this.keys.clear();
    addEventListener('keydown', kd); addEventListener('keyup', ku); addEventListener('blur', blur);
    el.addEventListener('mousedown', md); addEventListener('mouseup', mu); addEventListener('mousemove', mm); el.addEventListener('dblclick', dbl);
    this.detach = () => {
      removeEventListener('keydown', kd); removeEventListener('keyup', ku); removeEventListener('blur', blur);
      el.removeEventListener('mousedown', md); removeEventListener('mouseup', mu); removeEventListener('mousemove', mm); el.removeEventListener('dblclick', dbl);
    };
  }

  dispose(): void { this.detach(); }

  /** turn by (dx, dy) radians: right and down positive */
  look(dx: number, dy: number): void {
    this.camera.yaw += dx;
    this.camera.pitch = Math.max(-1.45, Math.min(1.45, this.camera.pitch - dy));
  }

  /** one frame of movement; true when the eye moved */
  update(dt: number): boolean {
    const k = this.keys, c = this.camera;
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const up = this.mode === 'fly' ? (k.has('Space') ? 1 : 0) - (k.has('KeyC') ? 1 : 0) : 0;
    const run = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = this.mode === 'fly' ? (run ? this.flyRunSpeed : this.flySpeed) : run ? this.runSpeed : this.walkSpeed;
    const f = c.forward(), r = c.right();
    // walking moves along the ground's plane; flying along the view
    const fx = this.mode === 'fly' ? f : [Math.sin(c.yaw), 0, -Math.cos(c.yaw)];
    const target = [0, 1, 2].map((i) => (fx[i] * fwd + r[i] * side) * speed + (i === 1 ? up * speed : 0));
    const len = Math.hypot(fwd, side, up);
    if (len > 1) for (let i = 0; i < 3; i++) target[i] /= len;
    const a = 1 - Math.exp(-dt * 8);
    for (let i = 0; i < 3; i++) this.vel[i] += (target[i] - this.vel[i]) * a;
    if (Math.hypot(...this.vel) < 0.01 && len === 0) { this.vel = [0, 0, 0]; }
    const p = c.position;
    const before = p.join();
    if (this.mode === 'walk') {
      // a blocked step slides along whichever axis is still free (along a wall or the water's edge)
      const g0 = this.ground(p[0], p[2]);
      const nx = p[0] + this.vel[0] * dt, nz = p[2] + this.vel[2] * dt;
      if (this.free(nx, nz, g0)) { p[0] = nx; p[2] = nz; }
      else if (this.free(nx, p[2], g0)) { p[0] = nx; this.vel[2] = 0; }
      else if (this.free(p[0], nz, g0)) { p[2] = nz; this.vel[0] = 0; }
      else { this.vel[0] = 0; this.vel[2] = 0; }
    } else {
      p[0] += this.vel[0] * dt; p[1] += this.vel[1] * dt; p[2] += this.vel[2] * dt;
    }
    const g = this.ground(p[0], p[2]);
    if (this.mode === 'walk' && Number.isFinite(g)) p[1] = g + this.eyeHeight;
    else if (Number.isFinite(g)) p[1] = Math.max(p[1], g + 0.5);
    return p.join() !== before;
  }
}
