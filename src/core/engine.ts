/**
 * The engine: a canvas, the GPU, a scene, the eye and its controller, the clock. Live it draws every animation frame;
 * capturing, the caller steps it one frame at a time (src/core/clock.ts) and reads each frame back.
 */
import { Camera } from './camera';
import { Clock } from './clock';
import { initGpu, type Gpu } from '../gpu/device';
import { Renderer, type FrameStats } from '../render/renderer';
import { DEFAULT_STYLE, type InkStyle } from '../ink/style';
import { Walker } from '../controls/walker';
import type { SceneData, Viewpoint } from '../scene/types';
import { addTerrain, groundAt } from '../terrain/chunks';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  style?: InkStyle;
  /** device pixels per CSS pixel to render at (default min(devicePixelRatio, 1)) */
  pixelRatio?: number;
}

export class Engine {
  readonly clock = new Clock();
  readonly camera = new Camera();
  readonly walker: Walker;
  scene?: SceneData;
  sceneStats?: FrameStats;
  /** real intervals between the last frames (ms), live */
  readonly frameTimes: number[] = [];
  private running = false;
  private raf = 0;
  private lastReal = 0;
  private listeners: ((e: Engine) => void)[] = [];

  private constructor(readonly canvas: HTMLCanvasElement, readonly gpu: Gpu, readonly renderer: Renderer, private pixelRatio: number) {
    this.walker = new Walker(this.camera);
  }

  static async create(o: EngineOptions): Promise<Engine> {
    const gpu = await initGpu(o.canvas);
    console.log(`[mo] GPU: ${gpu.adapter.info.vendor} ${gpu.adapter.info.architecture}`);
    const r = new Renderer(gpu, o.style ?? DEFAULT_STYLE);
    await r.init();
    const e = new Engine(o.canvas, gpu, r, o.pixelRatio ?? Math.min(devicePixelRatio, 1));
    e.resize();
    e.walker.attach(o.canvas);
    addEventListener('resize', () => e.resize());
    return e;
  }

  setScene(data: SceneData): FrameStats {
    if (data.terrain && data.terrain.drawn !== false) addTerrain(data);
    this.scene = data;
    this.renderer.sun = data.sun;
    this.sceneStats = this.renderer.setScene(data);
    this.walker.ground = (x, z) => groundAt(data, x, z);
    if (data.viewpoints[0]) this.goTo(data.viewpoints[0]);
    return this.sceneStats;
  }

  goTo(v: Viewpoint): void {
    this.camera.lookAt(v.position, v.target);
    this.camera.fovY = v.fovY;
    const g = this.walker.ground(v.position[0], v.position[2]);
    this.walker.mode = Number.isFinite(g) && v.position[1] - g > 4 ? 'fly' : 'walk';
  }

  resize(): void {
    const w = Math.max(2, Math.round(this.canvas.clientWidth * this.pixelRatio));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * this.pixelRatio));
    this.canvas.width = w; this.canvas.height = h;
    this.camera.width = w; this.camera.height = h; this.camera.aspect = w / h;
  }

  onFrame(f: (e: Engine) => void): void { this.listeners.push(f); }

  /** one frame: the controller moves the eye by the clock's dt, the renderer draws */
  step(capture = false): void {
    this.walker.update(this.clock.dt);
    this.renderer.render(this.camera, this.clock.now / 1000, capture);
    for (const f of this.listeners) f(this);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.resume();
    const loop = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      if (this.lastReal) { this.frameTimes.push(t - this.lastReal); if (this.frameTimes.length > 600) this.frameTimes.shift(); }
      this.lastReal = t;
      this.clock.tickLive(t);
      this.step();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.lastReal = 0;
  }

  /** capturing: stop the live loop, then each `captureFrame` advances the clock by exactly 1 / fps and reads it back */
  beginCapture(): void {
    this.stop();
    this.clock.mode = 'stepped';
  }

  async captureFrame(fps = 30): Promise<{ width: number; height: number; data: Uint8Array }> {
    this.clock.advance(1000 / fps);
    this.step(true);
    return this.renderer.readCapture();
  }

  endCapture(): void { this.start(); }
}
