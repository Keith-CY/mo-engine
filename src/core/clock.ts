/**
 * The engine's only source of time. Live it follows requestAnimationFrame; stepped (a video capture) it advances
 * only when told, by exactly one frame's length, however slowly the frames are made.
 */
export class Clock {
  /** ms since the clock started */
  now = 0;
  /** seconds since the last frame (live: clamped to 0.1 s, so a stall does not throw the walker across the map) */
  dt = 0;
  frame = 0;
  mode: 'live' | 'stepped' = 'live';
  private lastReal = -1;

  /** live: the frame's requestAnimationFrame time */
  tickLive(realMs: number): void {
    if (this.lastReal < 0) this.lastReal = realMs;
    const ms = Math.min(100, Math.max(0, realMs - this.lastReal));
    this.lastReal = realMs;
    this.advance(ms);
  }

  /** stepped: one frame of exactly `ms` */
  advance(ms: number): void {
    this.now += ms;
    this.dt = ms / 1000;
    this.frame++;
  }

  /** back to live time from now on (after a capture) */
  resume(): void {
    this.mode = 'live';
    this.lastReal = -1;
  }
}
