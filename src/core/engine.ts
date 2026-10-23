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
import type { LookData, SceneData, Viewpoint } from '../scene/types';
import { addTerrain } from '../terrain/chunks';
import { Walkable } from '../controls/walkable';

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
  /** the viewpoint last gone to (its field of view refits on resize) */
  private view?: Viewpoint;

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
    const W = (this.walkable = new Walkable(data));
    this.walker.ground = (x, z) => W.groundAt(x, z);
    this.walker.free = (x, z, fromG) => W.free(x, z, fromG);
    if (data.viewpoints[0]) this.goTo(data.viewpoints[0]);
    return this.sceneStats;
  }

  /** where the walker may stand in the scene */
  walkable?: Walkable;
  /** the look painted now (null: the scene's sun and the base style) */
  look: LookData | null = null;

  /** paints the world in one of its looks: its sun (or moon), its far ranges, petals only in spring */
  setLook(id: number): void {
    const L = this.scene?.looks?.find((l) => l.id === id);
    if (!L || !this.scene) return;
    this.look = L;
    this.renderer.sun = L.sun;
    const base = this.baseStyle ??= structuredClone(this.renderer.style);
    const st = structuredClone(base);
    const r = L.ink?.ranges;
    if (Array.isArray(r) && r.length >= 8) st.look.ranges = r.slice(0, 8) as NonNullable<typeof st.look.ranges>;
    if ((L.season ?? 'spring') !== 'spring' && st.look.petals) st.look.petals = [0, st.look.petals[1], st.look.petals[2], st.look.petals[3]];
    // 留白 measured from the look's own viewpoint
    const ink = L.ink ?? {};
    const vp = this.scene.viewpoints.find((v) => v.id === L.id);
    if (vp) st.look.shotPos = vp.position;
    if (typeof ink.groundY === 'number') st.look.groundY = ink.groundY;
    if (Array.isArray(ink.bands)) st.look.bands = (ink.bands as number[][]).slice(0, 3).map((b) => [b[0], b[1], b[2], b[3]] as [number, number, number, number]);
    if (Array.isArray(ink.mist) && ink.mist.length >= 4) st.look.mist = (ink.mist as number[]).slice(0, 4) as [number, number, number, number];
    // the sky, the water and the colour accents (linan's ink shots: src/ink/styles.js INK_SHOTS)
    const num = (k: string) => (typeof ink[k] === 'number' ? (ink[k] as number) : undefined);
    const v4 = (k: string) => (Array.isArray(ink[k]) && (ink[k] as number[]).length >= 4 ? ((ink[k] as number[]).slice(0, 4) as [number, number, number, number]) : undefined);
    st.look.accent = num('accent') ?? 0; st.look.warm = num('warm') ?? 0; st.look.glow = num('glow') ?? 0;
    st.look.clouds = num('clouds') ?? 0; st.look.cloudBands = num('cloudBands') ?? 0;
    st.look.skyTint = v4('skyTint'); st.look.moonCol = v4('moonCol');
    st.look.waterBase = num('waterBase') ?? num('water') ?? 0.05;
    st.look.night = !!(L.night || num('night')); st.look.skyInk = num('sky') ?? 0;
    this.renderer.setStyle(st);
  }
  private baseStyle?: InkStyle;

  goTo(v: Viewpoint): void {
    if (v.look !== undefined && v.look !== this.look?.id) this.setLook(v.look);
    this.camera.lookAt(v.position, v.target);
    this.view = v;
    this.fitFov();
    const g = this.walker.ground(v.position[0], v.position[2]);
    this.walker.mode = Number.isFinite(g) && v.position[1] - g > 4 ? 'fly' : 'walk';
  }

  resize(): void {
    const w = Math.max(2, Math.round(this.canvas.clientWidth * this.pixelRatio));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * this.pixelRatio));
    this.canvas.width = w; this.canvas.height = h;
    this.camera.width = w; this.camera.height = h; this.camera.aspect = w / h;
    this.fitFov();
  }

  /** the last viewpoint's field of view, widened on a screen narrower than its fitAspect */
  private fitFov(): void {
    const v = this.view;
    if (!v) return;
    const fit = v.fitAspect ?? 0, a = this.camera.aspect;
    const t = Math.tan((v.fovY * Math.PI) / 360);
    this.camera.fovY = fit > a ? (Math.atan((t * fit) / a) * 360) / Math.PI : v.fovY;
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
