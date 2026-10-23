/**
 * The frame: cull + LOD (compute) → G-buffer → painter → temporal resolve → the screen (docs/ARCHITECTURE.md §4).
 * Every pipeline is compiled before the first frame (no compile hitch while walking).
 */
import { mat4 } from 'wgpu-matrix';
import type { Camera } from '../core/camera';
import type { Gpu } from '../gpu/device';
import { bufferFrom } from '../gpu/device';
import { packStyle, type InkStyle } from '../ink/style';
import { GpuScene, PASSES, VERTEX_FLOATS } from '../scene/gpuscene';
import { alphaMips } from '../gpu/mips';
import type { SceneData } from '../scene/types';
import FRAME from '../shaders/frame.wgsl';
import CULL from '../shaders/cull.wgsl';
import GBUFFER from '../shaders/gbuffer.wgsl';
import INK from '../shaders/ink.wgsl';
import RESOLVE from '../shaders/resolve.wgsl';
import PRESENT from '../shaders/present.wgsl';
import SHADOW from '../shaders/shadow.wgsl';
import TERRAIN from '../shaders/terrain.wgsl';
import SURFACES from '../shaders/surfaces.wgsl';

const FRAME_FLOATS = 292;
/** the sun's shadow cascades: half size (m) of each box around the eye, map size (texels), depth half range (m) */
const CASCADE_RADII = [80, 450], SHADOW_SIZE = 2048, SHADOW_DEPTH = 1500;
const DRAW_STRIDE = 256;
/** sub-pixel offsets (px), Halton (2, 3), 16 frames */
const JITTER = Array.from({ length: 16 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

function halton(i: number, b: number): number {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}

interface Targets {
  w: number; h: number;
  a: GPUTexture; b: GPUTexture; c: GPUTexture; depth: GPUTexture; paint: GPUTexture; hist: GPUTexture[]; display: GPUTexture;
}

export interface FrameStats { slots: number; instances: number; triangles: number }

export class Renderer {
  private readonly device: GPUDevice;
  private readonly frameBuf: GPUBuffer;
  private readonly frameData = new Float32Array(FRAME_FLOATS);
  private styleBuf: GPUBuffer;
  private pipes!: { cull: GPUComputePipeline; gbuffer: GPURenderPipeline; shadow: GPURenderPipeline; ink: GPURenderPipeline; resolve: GPURenderPipeline; present: GPURenderPipeline; capture: GPURenderPipeline };
  private shadowMap: GPUTexture;
  private shadowPassBuf: GPUBuffer;
  private shadowFrameBG!: GPUBindGroup;
  private layouts!: { frame: GPUBindGroupLayout; shadowFrame: GPUBindGroupLayout; scene: GPUBindGroupLayout; draw: GPUBindGroupLayout };
  /** the alpha mask of alpha-tested cards (the scene's first texture; 1 × 1 white without one) */
  private alphaTex?: GPUTexture;
  private alphaSampler!: GPUSampler;
  /** the near terrain's paving map (1 on paving) and where it lies: origin x, z, 1 / extent x, z */
  private paveTex?: GPUTexture;
  private paveField: [number, number, number, number] = [0, 0, 0, 0];
  /** the slab paths (src/shaders/gbuffer.wgsl pathAt) */
  private pathBuf?: GPUBuffer;
  private shadowCmpSampler!: GPUSampler;
  private sampler: GPUSampler;
  private targets?: Targets;
  private scene?: GpuScene;
  private sceneBG?: GPUBindGroup;
  private drawBG?: GPUBindGroup;
  private drawBuf?: GPUBuffer;
  private cullBG?: GPUBindGroup;
  private frameBG!: GPUBindGroup;
  private passBGs?: { ink: GPUBindGroup; resolve: GPUBindGroup[]; present: GPUBindGroup[]; capture: GPUBindGroup[] };
  private frameNo = 0;
  private histIndex = 0;
  private prevViewProj = new Float32Array(16);
  private prevEye: [number, number, number] = [0, 0, 0];
  private prevPose = '';
  private restFrames = 0;
  style: InkStyle;
  /** GPU time per pass (ms), measured every 30th frame where the GPU has timestamp queries */
  gpuTimes: Record<string, number> = {};
  private timer?: { set: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; busy: boolean };
  /** LOD distance scale (> 1: coarser sooner) and hysteresis */
  lodScale = 1;
  lodHysteresis = 0.08;
  /** 0 the painting; 1 classes, 2 cast shadow (red) / sun (green) / sky (blue), 3 normals, 4 joints, 5 as 2 with the
   *  shadow casters' alpha cut off */
  debugView = 0;
  /** frames over which a change of LOD level dissolves (0: at once) */
  lodFadeFrames = 24;

  constructor(private readonly gpu: Gpu, style: InkStyle) {
    this.device = gpu.device;
    this.style = style;
    this.frameBuf = this.device.createBuffer({ label: 'mo frame', size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.styleBuf = bufferFrom(this.device, packStyle(style), GPUBufferUsage.STORAGE, 'mo style');
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.shadowMap = this.device.createTexture({ label: 'mo shadow map', size: [SHADOW_SIZE, SHADOW_SIZE, CASCADE_RADII.length], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const pass = new Uint32Array(CASCADE_RADII.length * 64);
    this.shadowPassBuf = bufferFrom(this.device, pass, GPUBufferUsage.UNIFORM, 'mo shadow passes');
    if (gpu.timestamps) {
      this.timer = {
        set: this.device.createQuerySet({ type: 'timestamp', count: 32 }),
        resolve: this.device.createBuffer({ size: 32 * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        read: this.device.createBuffer({ size: 32 * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        busy: false,
      };
    }
  }

  /** compiles every pipeline (call once, before the first frame) */
  async init(): Promise<void> {
    const d = this.device;
    const mod = (label: string, code: string) => d.createShaderModule({ label, code: FRAME + '\n' + code });
    const frame = d.createBindGroupLayout({ label: 'mo frame layout', entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 7, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
      { binding: 8, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
    ] });
    const shadowFrame = d.createBindGroupLayout({ label: 'mo shadow frame layout', entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 4, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
      { binding: 5, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
    ] });
    const scene = d.createBindGroupLayout({ label: 'mo scene layout', entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ] });
    const draw = d.createBindGroupLayout({ label: 'mo draw layout', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 } }] });
    this.layouts = { frame, shadowFrame, scene, draw };
    this.alphaSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
    this.shadowCmpSampler = d.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    this.bindFrame();
    const pass = new Uint32Array(CASCADE_RADII.length * 64);
    CASCADE_RADII.forEach((_, k) => pass.set([k, 0, 0, 0], k * 64));
    d.queue.writeBuffer(this.shadowPassBuf, 0, pass);
    const smod = mod('mo shadow', SHADOW + '\n' + TERRAIN);
    const gdesc = this.gbufferDesc(SURFACES);
    const fullscreen = (label: string, code: string, format: GPUTextureFormat) => {
      const m = mod(label, code);
      return d.createRenderPipelineAsync({ label, layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
    };
    const [cull, gbuffer, shadow, ink, resolve, present, capture] = await Promise.all([
      d.createComputePipelineAsync({ label: 'mo cull', layout: 'auto', compute: { module: mod('mo cull', CULL), entryPoint: 'main' } }),
      d.createRenderPipelineAsync(gdesc),
      d.createRenderPipelineAsync({
        label: 'mo shadow',
        layout: d.createPipelineLayout({ bindGroupLayouts: [shadowFrame, scene, draw] }),
        vertex: { module: smod, entryPoint: 'vs', buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 28, format: 'float32x2' }, { shaderLocation: 2, offset: 36, format: 'uint32' },
        ] }] },
        // (alpha-tested cards cut their shadows too: dappled light under the willows)
        fragment: { module: smod, entryPoint: 'fs', targets: [] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      }),
      fullscreen('mo ink', INK, 'rgba16float'),
      fullscreen('mo resolve', RESOLVE, 'rgba16float'),
      fullscreen('mo present', PRESENT, this.gpu.format),
      fullscreen('mo capture', PRESENT, 'rgba8unorm'),
    ]);
    this.pipes = { cull, gbuffer, shadow, ink, resolve, present, capture };
  }

  /** the season the world is painted in: meshes out of it are not drawn */
  setSeason(season: string): void { this.scene?.setSeason(this.device, season); }

  /** the G-buffer pipeline, with a world's surface functions (WGSL) compiled in */
  private surfacesCode = SURFACES;
  private gbufferDesc(surfaces: string): GPURenderPipelineDescriptor {
    const d = this.device;
    // (the surface functions may take derivatives inside their branches: anti-aliasing a pattern)
    const m = d.createShaderModule({ label: 'mo gbuffer', code: 'diagnostic(off, derivative_uniformity);\n' + FRAME + '\n' + GBUFFER + '\n' + TERRAIN + '\n' + surfaces });
    return {
      label: 'mo gbuffer',
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.layouts.frame, this.layouts.scene, this.layouts.draw] }),
      vertex: {
        module: m, entryPoint: 'vs',
        buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32' },
          { shaderLocation: 3, offset: 28, format: 'float32x2' },
          { shaderLocation: 4, offset: 36, format: 'uint32' },
          { shaderLocation: 5, offset: 40, format: 'uint32x2' },
        ] }],
      },
      fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'rgba32uint' }] },
      // (vegetation and roofs are seen from both sides; the fragment flips the normal of a back face)
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    };
  }

  /** the present pass's inputs: the resolved painting, and the G-buffer for the water's reflections */
  private presentBindGroup(pipe: GPURenderPipeline, t: Targets, k: number): GPUBindGroup {
    return this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: t.hist[k].createView() }, { binding: 1, resource: { buffer: this.frameBuf } },
      { binding: 2, resource: t.a.createView() }, { binding: 3, resource: t.depth.createView() }, { binding: 4, resource: this.sampler },
    ] });
  }

  /** the painter's inputs: the G-buffer, the style table and the instances (for the trees' own frames) */
  private inkBindGroup(t: Targets): GPUBindGroup {
    const d = this.device;
    const inst = this.scene?.instances ?? (this.noInstances ??= bufferFrom(d, new Uint32Array(16), GPUBufferUsage.STORAGE, 'mo instances (none)'));
    return d.createBindGroup({ layout: this.pipes.ink.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: t.a.createView() }, { binding: 2, resource: t.b.createView() },
      { binding: 3, resource: t.c.createView() }, { binding: 4, resource: t.depth.createView() }, { binding: 5, resource: { buffer: this.styleBuf } },
      { binding: 6, resource: { buffer: inst } },
    ] });
  }
  private noInstances?: GPUBuffer;
  /** every slot's indirect draw, recorded once (the counts live on the GPU, so the list never changes): a city's
   *  thousands of draws cost the CPU nothing per frame. Made again when a bind group they hold changes */
  private bundles?: { gbuffer: GPURenderBundle; shadow: GPURenderBundle[] };

  private recordBundles(s: GpuScene): { gbuffer: GPURenderBundle; shadow: GPURenderBundle[] } {
    const d = this.device;
    const gb = d.createRenderBundleEncoder({ label: 'mo gbuffer draws', colorFormats: ['rgba16float', 'rgba16float', 'rgba32uint'], depthStencilFormat: 'depth32float' });
    gb.setPipeline(this.pipes.gbuffer);
    gb.setBindGroup(0, this.frameBG);
    gb.setBindGroup(1, this.sceneBG!);
    gb.setVertexBuffer(0, s.vertices);
    gb.setIndexBuffer(s.indices, 'uint32');
    for (let i = 0; i < s.slots.length; i++) {
      gb.setBindGroup(2, this.drawBG!, [i * DRAW_STRIDE]);
      gb.drawIndexedIndirect(s.args, i * 20);
    }
    const shadow = CASCADE_RADII.map((_, k) => {
      const e = d.createRenderBundleEncoder({ label: `mo shadow ${k} draws`, colorFormats: [], depthStencilFormat: 'depth32float' });
      e.setPipeline(this.pipes.shadow);
      e.setBindGroup(0, this.shadowFrameBG, [k * 256]);
      e.setBindGroup(1, this.sceneBG!);
      e.setVertexBuffer(0, s.vertices);
      e.setIndexBuffer(s.indices, 'uint32');
      for (let i = 0; i < s.slots.length; i++) {
        e.setBindGroup(2, this.drawBG!, [i * DRAW_STRIDE]);
        e.drawIndexedIndirect(s.args, ((k + 1) * s.slots.length + i) * 20);
      }
      return e.finish();
    });
    return { gbuffer: gb.finish(), shadow };
  }

  /** the bind groups that hold the alpha mask (made again when a scene brings its own) */
  private bindFrame(): void {
    const d = this.device;
    if (!this.alphaTex) {
      this.alphaTex = d.createTexture({ label: 'mo alpha (none)', size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      d.queue.writeTexture({ texture: this.alphaTex }, new Uint8Array([255]), { bytesPerRow: 1 }, [1, 1]);
    }
    const alpha = this.alphaTex.createView();
    if (!this.paveTex) {
      this.paveTex = d.createTexture({ label: 'mo pave (none)', size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      d.queue.writeTexture({ texture: this.paveTex }, new Uint8Array([0]), { bytesPerRow: 1 }, [1, 1]);
    }
    this.frameBG = d.createBindGroup({ layout: this.layouts.frame, entries: [
      { binding: 0, resource: { buffer: this.frameBuf } },
      { binding: 1, resource: this.shadowMap.createView({ dimension: '2d-array' }) },
      { binding: 2, resource: this.shadowCmpSampler },
      { binding: 3, resource: alpha }, { binding: 4, resource: this.alphaSampler },
      { binding: 5, resource: this.paveTex.createView() },
      { binding: 6, resource: { buffer: this.pathBuf ?? (this.pathBuf = bufferFrom(d, new Float32Array(4), GPUBufferUsage.STORAGE, 'mo paths (none)')) } },
      { binding: 7, resource: this.fieldView(0) }, { binding: 8, resource: this.fieldView(1) },
    ] });
    this.shadowFrameBG = d.createBindGroup({ layout: this.layouts.shadowFrame, entries: [
      { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: { buffer: this.shadowPassBuf, size: 16 } },
      { binding: 2, resource: alpha }, { binding: 3, resource: this.alphaSampler },
      { binding: 4, resource: this.fieldView(0) }, { binding: 5, resource: this.fieldView(1) },
    ] });
    this.bundles = undefined;
  }

  /** the scene's slab paths: up to 4 centre lines of up to 8 points, with their arc lengths */
  private uploadPaths(data: SceneData): void {
    const ps = (data.paths ?? []).slice(0, 4);
    if (!ps.length) return;
    const f = new Float32Array(4 + ps.length * 36);
    f[0] = ps.length;
    ps.forEach((p, k) => {
      const pts = p.points.slice(0, 8);
      f.set([pts.length, p.halfWidth, p.slab, p.crown], 4 + k * 36);
      let s = 0;
      pts.forEach((q, j) => {
        if (j) s += Math.hypot(q[0] - pts[j - 1][0], q[1] - pts[j - 1][1]);
        f.set([q[0], q[1], s, 0], 8 + k * 36 + j * 4);
      });
    });
    this.pathBuf?.destroy();
    this.pathBuf = bufferFrom(this.device, f, GPUBufferUsage.STORAGE, 'mo paths');
  }

  /** the heightfields as textures the terrain's vertices are lifted from (src/shaders/terrain.wgsl) */
  private fieldTex: (GPUTexture | undefined)[] = [undefined, undefined];
  private fieldInfo = new Float32Array(16);
  private fieldView(k: number): GPUTextureView {
    if (!this.fieldTex[k]) {
      const t = this.device.createTexture({ label: 'mo field (none)', size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.device.queue.writeTexture({ texture: t }, new Float32Array([0]), { bytesPerRow: 4 }, [1, 1]);
      this.fieldTex[k] = t;
    }
    return this.fieldTex[k]!.createView();
  }
  private uploadFields(data: SceneData): void {
    const fields = [data.terrain?.near, data.terrain?.far];
    this.fieldInfo.fill(0);
    fields.forEach((f, k) => {
      this.fieldTex[k]?.destroy();
      this.fieldTex[k] = undefined;
      if (!f || data.terrain?.drawn === false) return;
      const t = this.device.createTexture({ label: `mo field ${k ? 'far' : 'near'}`, size: [f.width, f.depth], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      // (rows padded to 256 bytes, in bands so no large copy is made)
      const bpr = Math.ceil((f.width * 4) / 256) * 256, rowsPer = Math.max(1, Math.floor((16 << 20) / bpr));
      for (let z0 = 0; z0 < f.depth; z0 += rowsPer) {
        const rows = Math.min(rowsPer, f.depth - z0);
        const band = new Float32Array((bpr / 4) * rows);
        for (let z = 0; z < rows; z++) band.set(f.heights.subarray((z0 + z) * f.width, (z0 + z + 1) * f.width), (z * bpr) / 4);
        this.device.queue.writeTexture({ texture: t, origin: [0, z0] }, band, { bytesPerRow: bpr }, [f.width, rows]);
      }
      this.fieldTex[k] = t;
      this.fieldInfo.set([f.origin[0], f.origin[1], f.cell, f.width, f.depth, 1, 0, 0], k * 8);
    });
  }

  /** the near terrain's class map as a paving map (1 where it says PAVE) */
  private uploadPave(data: SceneData): void {
    const n = data.terrain?.near;
    if (!n?.classes) return;
    const PAVE = data.classes.PAVE ?? 27;
    const m = new Uint8Array(n.width * n.depth);
    for (let i = 0; i < m.length; i++) m[i] = n.classes[i] === PAVE ? 255 : 0;
    const bpr = Math.ceil(n.width / 256) * 256, rows = new Uint8Array(bpr * n.depth);
    for (let z = 0; z < n.depth; z++) rows.set(m.subarray(z * n.width, (z + 1) * n.width), z * bpr);
    this.paveTex?.destroy();
    this.paveTex = this.device.createTexture({ label: 'mo pave', size: [n.width, n.depth], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: this.paveTex }, rows, { bytesPerRow: bpr }, [n.width, n.depth]);
    // (texel centres at the samples: the map spans one cell more than the samples' extent)
    this.paveField = [n.origin[0] - n.cell / 2, n.origin[1] - n.cell / 2, 1 / (n.width * n.cell), 1 / (n.depth * n.cell)];
  }

  /** the scene's alpha mask on the GPU, with coverage-preserving mip levels */
  private uploadAlpha(data: SceneData): void {
    const t = data.textures?.[0];
    if (!t) return;
    if ((data.textures?.length ?? 0) > 1) console.warn(`[mo] ${data.textures!.length} textures: only the first (${t.name}) is used`);
    const cutoff = data.meshes.find((m) => m.mask)?.mask?.cutoff ?? 0.5;
    const mips = alphaMips(t.data, t.width, t.height, cutoff);
    const tex = this.device.createTexture({ label: `mo alpha ${t.name}`, size: [t.width, t.height], format: 'r8unorm', mipLevelCount: mips.length, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    mips.forEach((m, level) => this.device.queue.writeTexture({ texture: tex, mipLevel: level }, m.data, { bytesPerRow: m.width }, [m.width, m.height]));
    this.alphaTex?.destroy();
    this.alphaTex = tex;
  }

  setStyle(style: InkStyle): void {
    this.style = style;
    this.device.queue.writeBuffer(this.styleBuf, 0, packStyle(style));
  }

  setScene(data: SceneData): FrameStats {
    const d = this.device;
    // a world's own surface functions: the G-buffer pipeline made again with them
    const surf = data.surfaces ?? SURFACES;
    if (surf !== this.surfacesCode) { this.surfacesCode = surf; this.pipes.gbuffer = d.createRenderPipeline(this.gbufferDesc(surf)); }
    const s = (this.scene = new GpuScene(d, data));
    this.meshNames = data.meshes.map((m) => m.name);
    this.uploadFields(data);
    this.uploadPave(data);
    this.uploadPaths(data);
    if (this.targets && this.passBGs) this.passBGs.ink = this.inkBindGroup(this.targets);
    this.uploadAlpha(data);
    this.bindFrame();
    this.sceneBG = d.createBindGroup({ layout: this.layouts.scene, entries: [
      { binding: 0, resource: { buffer: s.instances } }, { binding: 1, resource: { buffer: s.visible } },
      { binding: 2, resource: { buffer: s.lodState } },
    ] });
    const draws = new ArrayBuffer(Math.max(1, s.slots.length) * DRAW_STRIDE);
    const du = new Uint32Array(draws), df = new Float32Array(draws);
    s.slots.forEach((sl, i) => {
      const o = (i * DRAW_STRIDE) / 4;
      du[o] = sl.visibleBase; du[o + 1] = sl.cls; df[o + 2] = sl.tone; du[o + 3] = sl.hasTone ? 1 : 0; du[o + 4] = sl.level; df[o + 5] = sl.cutoff; df[o + 6] = sl.lift;
    });
    this.drawBuf = bufferFrom(d, new Uint8Array(draws), GPUBufferUsage.UNIFORM, 'mo draws');
    this.drawBG = d.createBindGroup({ layout: this.layouts.draw, entries: [{ binding: 0, resource: { buffer: this.drawBuf, size: 32 } }] });
    this.cullBG = d.createBindGroup({ layout: this.pipes.cull.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: { buffer: s.instances } },
      { binding: 2, resource: { buffer: s.batchOf } }, { binding: 3, resource: { buffer: s.batches } },
      { binding: 4, resource: { buffer: s.slotBase } }, { binding: 5, resource: { buffer: s.lodState } },
      { binding: 6, resource: { buffer: s.args } }, { binding: 7, resource: { buffer: s.visible } },
    ] });
    const pass = new Uint32Array(CASCADE_RADII.length * 64);
    CASCADE_RADII.forEach((_, k) => pass.set([k, (k + 1) * s.visibleTotal, 0, 0], k * 64));
    d.queue.writeBuffer(this.shadowPassBuf, 0, pass);
    this.bundles = undefined;
    this.frameNo = 0;
    return { slots: s.slots.length, instances: s.instanceCount, triangles: s.triangles };
  }

  private ensureTargets(w: number, h: number): Targets {
    if (this.targets && this.targets.w === w && this.targets.h === h) return this.targets;
    for (const t of Object.values(this.targets ?? {})) if (Array.isArray(t)) t.forEach((x) => x.destroy()); else if (t instanceof GPUTexture) t.destroy();
    const d = this.device;
    const tex = (label: string, format: GPUTextureFormat, extra = 0) => d.createTexture({ label, size: [w, h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | extra });
    const t: Targets = {
      w, h,
      a: tex('mo gA', 'rgba16float'), b: tex('mo gB', 'rgba16float'), c: tex('mo gC', 'rgba32uint'), depth: tex('mo depth', 'depth32float'),
      paint: tex('mo paint', 'rgba16float'), hist: [tex('mo hist 0', 'rgba16float'), tex('mo hist 1', 'rgba16float')],
      display: tex('mo display', 'rgba8unorm', GPUTextureUsage.COPY_SRC),
    };
    this.targets = t;
    const P = this.pipes;
    this.passBGs = {
      ink: this.inkBindGroup(t),
      resolve: [0, 1].map((k) => d.createBindGroup({ layout: P.resolve.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: t.paint.createView() },
        { binding: 2, resource: t.hist[1 - k].createView() }, { binding: 3, resource: t.depth.createView() }, { binding: 4, resource: this.sampler },
      ] })),
      present: [0, 1].map((k) => this.presentBindGroup(P.present, t, k)),
      capture: [0, 1].map((k) => this.presentBindGroup(P.capture, t, k)),
    };
    this.frameNo = 0;
    return t;
  }

  /** fills the frame's uniforms from the camera */
  private writeFrame(cam: Camera, timeS: number): void {
    const f = this.frameData;
    const pose = `${cam.position.join()},${cam.yaw},${cam.pitch},${cam.fovY}`;
    const moved = pose !== this.prevPose;
    this.restFrames = moved ? 0 : Math.min(this.restFrames + 1, 1e6);
    this.prevPose = pose;
    const j = JITTER[this.frameNo % JITTER.length];
    cam.jitter = [j[0], j[1]];
    const viewRot = cam.viewRotation();
    const proj = cam.projection();
    const viewProj = mat4.multiply(proj, viewRot);
    const unjittered = mat4.multiply(cam.projection(new Float32Array(16), false), viewRot);
    f.set(viewRot, 0); f.set(proj, 16); f.set(viewProj, 32); f.set(mat4.inverse(viewProj), 48);
    f.set(this.frameNo === 0 ? unjittered : this.prevViewProj, 64);
    const e = cam.position;
    f.set([e[0], e[1], e[2], timeS], 80);
    const de = this.frameNo === 0 ? [0, 0, 0] : [e[0] - this.prevEye[0], e[1] - this.prevEye[1], e[2] - this.prevEye[2]];
    f.set([de[0], de[1], de[2], this.frameNo], 84);
    const L = this.style.look;
    f.set([...this.sun, 1], 88);
    f.set([cam.width, cam.height, 1 / cam.width, 1 / cam.height], 92);
    f.set([j[0], j[1], 0, 0], 96);
    const pxAngle = (2 * Math.tan((cam.fovY * Math.PI) / 360)) / cam.height;
    f.set([pxAngle, cam.near, this.restFrames, moved ? 1 : 0], 100);
    // frustum planes from the (eye-relative) view-projection: left, right, bottom, top, near
    const m = viewProj, row = (r: number) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    const planes = [r3.map((v, i) => v + r0[i]), r3.map((v, i) => v - r0[i]), r3.map((v, i) => v + r1[i]), r3.map((v, i) => v - r1[i]), r3.map((v, i) => v - r2[i])];
    planes.forEach((p, k) => { const l = Math.hypot(p[0], p[1], p[2]) || 1; f.set([p[0] / l, p[1] / l, p[2] / l, p[3] / l], 104 + k * 4); });
    f.set([this.scene?.instanceCount ?? 0, this.lodHysteresis, 1 / this.lodScale, this.lodFadeFrames], 124);
    f.set([L.hazeDistance, L.skyLight, L.sunLight, L.paperDrift], 128);
    f.set([...L.paperColor, L.paperTexture], 132);
    f.set([...L.inkColor, L.lineStrength], 136);
    this.writeLight(f, e);
    f.set([this.scene?.slots.length ?? 0, this.scene?.visibleTotal ?? 0, CASCADE_RADII.length, this.debugView], 196);
    f.set(this.paveField, 200);
    const rg = L.ranges ?? [0, 0, 0, 0, 0, 0, 0, 0], deg = Math.PI / 180;
    f.set([rg[0] * deg, rg[1] * deg, rg[2] * deg, rg[3], rg[4] * deg, rg[5] * deg, rg[6], rg[7] * deg], 204);
    f.set(L.petals ?? [0, 0, 0, 0], 212);
    f.set([L.layers ?? 0, L.pool ?? 0, 0, 0], 216);
    f.set([...(L.shotPos ?? [0, 0, 0]), L.groundY ?? 0], 220);
    for (let k = 0; k < 3; k++) f.set(L.bands?.[k] ?? [0, 0, 0, 0], 224 + k * 4);
    f.set(L.mist ?? [0, 0, 0, 0], 236);
    f.set([L.accent ?? 0, L.warm ?? 0, L.glow ?? 0, L.clouds ?? 0], 240);
    f.set(L.skyTint ?? [0, 0, 0, 0], 244);
    f.set(L.moonCol ?? [0, 0, 0, 0], 248);
    f.set([L.waterBase ?? 0.05, L.night ? 1 : 0, L.skyInk ?? 0, L.cloudBands ?? 0], 252);
    f.set([...(L.waterRefl ?? [1, 0]), 0, 0], 256);
    f.set([...(L.shotDir ?? [0, 1]), L.waves ?? 0, L.waveMode ?? 0], 260);
    f.set(L.gains ?? [1, 1, 1, 1], 264);
    f.set([L.lineNear ?? 8, L.lineFar ?? 900, L.snow ?? 0, L.ridgeFrom ?? 900], 268);
    f.set([...(L.veil ?? [0, 0, 0]), L.rock ?? 1], 272);
    f.set(this.fieldInfo, 276);
    this.device.queue.writeBuffer(this.frameBuf, 0, f);
    this.prevViewProj.set(unjittered);
    this.prevEye = [e[0], e[1], e[2]];
  }

  sun: [number, number, number] = [0.45, 0.42, -0.79];

  /** the sun's light space and each cascade: a box around the eye, snapped to whole texels of the world (so walking
   *  moves the shadows' texels in whole steps and turning moves nothing) */
  private writeLight(f: Float32Array, eye: [number, number, number]): void {
    const b = this.sun;
    let r = [b[2], 0, -b[0]];                       // (0, 1, 0) × b
    let l = Math.hypot(r[0], r[1], r[2]);
    if (l < 1e-4) { r = [1, 0, 0]; l = 1; }
    r = r.map((x) => x / l);
    const u = [b[1] * r[2] - b[2] * r[1], b[2] * r[0] - b[0] * r[2], b[0] * r[1] - b[1] * r[0]];
    f.set([r[0], u[0], b[0], 0, r[1], u[1], b[1], 0, r[2], u[2], b[2], 0, 0, 0, 0, 1], 140);
    const ex = r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2], ey = u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2];
    const Z = SHADOW_DEPTH;
    CASCADE_RADII.forEach((R, k) => {
      const texel = (2 * R) / SHADOW_SIZE;
      const cx = Math.round(ex / texel) * texel - ex, cy = Math.round(ey / texel) * texel - ey;
      f.set([
        r[0] / R, u[0] / R, -b[0] / (2 * Z), 0,
        r[1] / R, u[1] / R, -b[1] / (2 * Z), 0,
        r[2] / R, u[2] / R, -b[2] / (2 * Z), 0,
        -cx / R, -cy / R, 0.5, 1,
      ], 156 + k * 16);
      f.set([cx, cy, R, Z], 188 + k * 4);
    });
  }

  /** draws one frame to the canvas (and to the capture target when `capture`) */
  render(cam: Camera, timeS: number, capture = false): void {
    const d = this.device;
    const t = this.ensureTargets(cam.width, cam.height);
    this.writeFrame(cam, timeS);
    const enc = d.createCommandEncoder({ label: 'mo frame' });
    const s = this.scene;
    const T = this.timer && !this.timer.busy && this.frameNo % 30 === 0 ? this.timer : undefined;
    const names: string[] = [];
    const tw = (name: string): GPUComputePassTimestampWrites | undefined => {
      if (!T) return undefined;
      names.push(name);
      return { querySet: T.set, beginningOfPassWriteIndex: names.length * 2 - 2, endOfPassWriteIndex: names.length * 2 - 1 };
    };
    if (s && this.cullBG) {
      enc.copyBufferToBuffer(s.argsTemplate, 0, s.args, 0, s.slots.length * 20 * PASSES);
      const cp = enc.beginComputePass({ label: 'mo cull', timestampWrites: tw('cull') });
      cp.setPipeline(this.pipes.cull);
      cp.setBindGroup(0, this.cullBG);
      cp.dispatchWorkgroups(Math.ceil(s.instanceCount / 64));
      cp.end();
    }
    for (let k = 0; k < CASCADE_RADII.length; k++) {
      const sp = enc.beginRenderPass({
        label: `mo shadow ${k}`, colorAttachments: [], timestampWrites: tw(`shadow${k}`),
        depthStencilAttachment: { view: this.shadowMap.createView({ dimension: '2d', baseArrayLayer: k, arrayLayerCount: 1 }), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
      });
      if (s && this.sceneBG && this.drawBG) {
        this.bundles ??= this.recordBundles(s);
        sp.executeBundles([this.bundles.shadow[k]]);
      }
      sp.end();
    }
    const g = enc.beginRenderPass({
      label: 'mo gbuffer', timestampWrites: tw('gbuffer'),
      colorAttachments: [
        { view: t.a.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        { view: t.b.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        { view: t.c.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
      depthStencilAttachment: { view: t.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
    });
    if (s && this.sceneBG && this.drawBG) {
      this.bundles ??= this.recordBundles(s);
      g.executeBundles([this.bundles.gbuffer]);
    }
    g.end();
    const pass = (label: string, view: GPUTextureView, pipe: GPURenderPipeline, bg: GPUBindGroup) => {
      const p = enc.beginRenderPass({ label, timestampWrites: tw(label.slice(3)), colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }] });
      p.setPipeline(pipe); p.setBindGroup(0, bg); p.draw(3); p.end();
    };
    const B = this.passBGs!;
    pass('mo ink', t.paint.createView(), this.pipes.ink, B.ink);
    const k = this.histIndex;
    pass('mo resolve', t.hist[k].createView(), this.pipes.resolve, B.resolve[k]);
    pass('mo present', this.gpu.context.getCurrentTexture().createView(), this.pipes.present, B.present[k]);
    if (capture) pass('mo capture', t.display.createView(), this.pipes.capture, B.capture[k]);
    if (T && names.length) {
      enc.resolveQuerySet(T.set, 0, names.length * 2, T.resolve, 0);
      enc.copyBufferToBuffer(T.resolve, 0, T.read, 0, names.length * 16);
    }
    d.queue.submit([enc.finish()]);
    if (T && names.length) {
      T.busy = true;
      T.read.mapAsync(GPUMapMode.READ).then(() => {
        const q = new BigUint64Array(T.read.getMappedRange(0, names.length * 16));
        const out: Record<string, number> = {};
        let total = 0;
        names.forEach((n, i) => { const ms = Number(q[i * 2 + 1] - q[i * 2]) / 1e6; out[n] = +ms.toFixed(2); total += ms; });
        out.total = +total.toFixed(2);
        this.gpuTimes = out;
        T.read.unmap();
        T.busy = false;
      }).catch(() => { T.busy = false; });
    }
    this.histIndex = 1 - k;
    this.frameNo++;
  }

  /** a cut (a teleport, the start of a capture): every instance takes its level afresh, without dissolving from
   *  where the eye was, and the painting starts without history */
  cut(): void {
    const s = this.scene;
    if (s) this.device.queue.writeBuffer(s.lodState, 0, new Uint32Array(s.instanceCount).fill(0xffff));
    this.frameNo = 0;
  }

  /** every instance's current LOD level (0xff: none yet; ≥ levels: beyond the last), for the comfort checks */
  async readLodState(): Promise<Uint32Array> {
    const s = this.scene;
    if (!s) return new Uint32Array(0);
    const buf = this.device.createBuffer({ size: s.instanceCount * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(s.lodState, 0, buf, 0, s.instanceCount * 4);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(buf.getMappedRange().slice(0));
    buf.unmap(); buf.destroy();
    return out;
  }

  /** what the last frame drew, per pass (the view, then each cascade): instances and triangles, and the slots with
   *  the most triangles (the diagnostics of a large scene) */
  async readDrawStats(top = 8): Promise<{ passes: { instances: number; triangles: number }[]; heaviest: { pass: number; mesh: string; level: number; instances: number; triangles: number }[] }> {
    const s = this.scene;
    if (!s) return { passes: [], heaviest: [] };
    const size = s.slots.length * 20 * PASSES;
    const buf = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(s.args, 0, buf, 0, size);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const a = new Uint32Array(buf.getMappedRange().slice(0));
    buf.unmap(); buf.destroy();
    const passes: { instances: number; triangles: number }[] = [], all: { pass: number; mesh: string; level: number; instances: number; triangles: number }[] = [];
    for (let p = 0; p < PASSES; p++) {
      let inst = 0, tris = 0;
      s.slots.forEach((sl, i) => {
        const n = a[(p * s.slots.length + i) * 5 + 1], t = (n * sl.indexCount) / 3;
        inst += n; tris += t;
        if (n) all.push({ pass: p, mesh: this.meshNames[sl.mesh] ?? String(sl.mesh), level: sl.level, instances: n, triangles: t });
      });
      passes.push({ instances: inst, triangles: tris });
    }
    all.sort((x, y) => y.triangles - x.triangles);
    return { passes, heaviest: all.slice(0, top) };
  }
  private meshNames: string[] = [];

  /** the last captured frame as RGBA bytes (width × height × 4) */
  async readCapture(): Promise<{ width: number; height: number; data: Uint8Array }> {
    const t = this.targets!;
    const bpr = Math.ceil((t.w * 4) / 256) * 256;
    const buf = this.device.createBuffer({ size: bpr * t.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: t.display }, { buffer: buf, bytesPerRow: bpr }, [t.w, t.h]);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(t.w * t.h * 4);
    for (let y = 0; y < t.h; y++) out.set(src.subarray(y * bpr, y * bpr + t.w * 4), y * t.w * 4);
    buf.unmap(); buf.destroy();
    return { width: t.w, height: t.h, data: out };
  }
}
