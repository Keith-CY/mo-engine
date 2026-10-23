/**
 * The frame: cull + LOD (compute) → G-buffer → painter → temporal resolve → the screen (docs/ARCHITECTURE.md §4).
 * Every pipeline is compiled before the first frame (no compile hitch while walking).
 */
import { mat4 } from 'wgpu-matrix';
import type { Camera } from '../core/camera';
import type { Gpu } from '../gpu/device';
import { bufferFrom } from '../gpu/device';
import { packStyle, type InkStyle } from '../ink/style';
import { GpuScene, VERTEX_FLOATS } from '../scene/gpuscene';
import type { SceneData } from '../scene/types';
import FRAME from '../shaders/frame.wgsl';
import CULL from '../shaders/cull.wgsl';
import GBUFFER from '../shaders/gbuffer.wgsl';
import INK from '../shaders/ink.wgsl';
import RESOLVE from '../shaders/resolve.wgsl';
import PRESENT from '../shaders/present.wgsl';

const FRAME_FLOATS = 140;
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
  private pipes!: { cull: GPUComputePipeline; gbuffer: GPURenderPipeline; ink: GPURenderPipeline; resolve: GPURenderPipeline; present: GPURenderPipeline; capture: GPURenderPipeline };
  private layouts!: { frame: GPUBindGroupLayout; scene: GPUBindGroupLayout; draw: GPUBindGroupLayout };
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
  /** LOD distance scale (> 1: coarser sooner) and hysteresis */
  lodScale = 1;
  lodHysteresis = 0.08;

  constructor(private readonly gpu: Gpu, style: InkStyle) {
    this.device = gpu.device;
    this.style = style;
    this.frameBuf = this.device.createBuffer({ label: 'mo frame', size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.styleBuf = bufferFrom(this.device, packStyle(style), GPUBufferUsage.STORAGE, 'mo style');
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  /** compiles every pipeline (call once, before the first frame) */
  async init(): Promise<void> {
    const d = this.device;
    const mod = (label: string, code: string) => d.createShaderModule({ label, code: FRAME + '\n' + code });
    const frame = d.createBindGroupLayout({ label: 'mo frame layout', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    const scene = d.createBindGroupLayout({ label: 'mo scene layout', entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ] });
    const draw = d.createBindGroupLayout({ label: 'mo draw layout', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } }] });
    this.layouts = { frame, scene, draw };
    this.frameBG = d.createBindGroup({ layout: frame, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] });
    const gmod = mod('mo gbuffer', GBUFFER);
    const fullscreen = (label: string, code: string, format: GPUTextureFormat) => {
      const m = mod(label, code);
      return d.createRenderPipelineAsync({ label, layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
    };
    const [cull, gbuffer, ink, resolve, present, capture] = await Promise.all([
      d.createComputePipelineAsync({ label: 'mo cull', layout: 'auto', compute: { module: mod('mo cull', CULL), entryPoint: 'main' } }),
      d.createRenderPipelineAsync({
        label: 'mo gbuffer',
        layout: d.createPipelineLayout({ bindGroupLayouts: [frame, scene, draw] }),
        vertex: {
          module: gmod, entryPoint: 'vs',
          buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32' },
          ] }],
        },
        fragment: { module: gmod, entryPoint: 'fs', targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'rgba32uint' }] },
        // (vegetation and roofs are seen from both sides; the fragment flips the normal of a back face)
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      }),
      fullscreen('mo ink', INK, 'rgba16float'),
      fullscreen('mo resolve', RESOLVE, 'rgba16float'),
      fullscreen('mo present', PRESENT, this.gpu.format),
      fullscreen('mo capture', PRESENT, 'rgba8unorm'),
    ]);
    this.pipes = { cull, gbuffer, ink, resolve, present, capture };
  }

  setStyle(style: InkStyle): void {
    this.style = style;
    this.device.queue.writeBuffer(this.styleBuf, 0, packStyle(style));
  }

  setScene(data: SceneData): FrameStats {
    const d = this.device;
    const s = (this.scene = new GpuScene(d, data));
    this.sceneBG = d.createBindGroup({ layout: this.layouts.scene, entries: [
      { binding: 0, resource: { buffer: s.instances } }, { binding: 1, resource: { buffer: s.visible } },
    ] });
    const draws = new ArrayBuffer(Math.max(1, s.slots.length) * DRAW_STRIDE);
    const du = new Uint32Array(draws), df = new Float32Array(draws);
    s.slots.forEach((sl, i) => {
      const o = (i * DRAW_STRIDE) / 4;
      du[o] = sl.visibleBase; du[o + 1] = sl.cls; df[o + 2] = sl.tone; du[o + 3] = sl.hasTone ? 1 : 0;
    });
    this.drawBuf = bufferFrom(d, new Uint8Array(draws), GPUBufferUsage.UNIFORM, 'mo draws');
    this.drawBG = d.createBindGroup({ layout: this.layouts.draw, entries: [{ binding: 0, resource: { buffer: this.drawBuf, size: 16 } }] });
    this.cullBG = d.createBindGroup({ layout: this.pipes.cull.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: { buffer: s.instances } },
      { binding: 2, resource: { buffer: s.batchOf } }, { binding: 3, resource: { buffer: s.batches } },
      { binding: 4, resource: { buffer: s.slotBase } }, { binding: 5, resource: { buffer: s.lodState } },
      { binding: 6, resource: { buffer: s.args } }, { binding: 7, resource: { buffer: s.visible } },
    ] });
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
      ink: d.createBindGroup({ layout: P.ink.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: t.a.createView() }, { binding: 2, resource: t.b.createView() },
        { binding: 3, resource: t.c.createView() }, { binding: 4, resource: t.depth.createView() }, { binding: 5, resource: { buffer: this.styleBuf } },
      ] }),
      resolve: [0, 1].map((k) => d.createBindGroup({ layout: P.resolve.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: t.paint.createView() },
        { binding: 2, resource: t.hist[1 - k].createView() }, { binding: 3, resource: t.depth.createView() }, { binding: 4, resource: this.sampler },
      ] })),
      present: [0, 1].map((k) => d.createBindGroup({ layout: P.present.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.hist[k].createView() }] })),
      capture: [0, 1].map((k) => d.createBindGroup({ layout: P.capture.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.hist[k].createView() }] })),
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
    f.set([this.scene?.instanceCount ?? 0, this.lodHysteresis, 1 / this.lodScale, 0], 124);
    f.set([L.hazeDistance, L.skyLight, L.sunLight, L.paperDrift], 128);
    f.set([...L.paperColor, L.paperTexture], 132);
    f.set([...L.inkColor, L.lineStrength], 136);
    this.device.queue.writeBuffer(this.frameBuf, 0, f);
    this.prevViewProj.set(unjittered);
    this.prevEye = [e[0], e[1], e[2]];
  }

  sun: [number, number, number] = [0.45, 0.42, -0.79];

  /** draws one frame to the canvas (and to the capture target when `capture`) */
  render(cam: Camera, timeS: number, capture = false): void {
    const d = this.device;
    const t = this.ensureTargets(cam.width, cam.height);
    this.writeFrame(cam, timeS);
    const enc = d.createCommandEncoder({ label: 'mo frame' });
    const s = this.scene;
    if (s && this.cullBG) {
      enc.copyBufferToBuffer(s.argsTemplate, 0, s.args, 0, s.slots.length * 20);
      const cp = enc.beginComputePass({ label: 'mo cull' });
      cp.setPipeline(this.pipes.cull);
      cp.setBindGroup(0, this.cullBG);
      cp.dispatchWorkgroups(Math.ceil(s.instanceCount / 64));
      cp.end();
    }
    const g = enc.beginRenderPass({
      label: 'mo gbuffer',
      colorAttachments: [
        { view: t.a.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        { view: t.b.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        { view: t.c.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
      depthStencilAttachment: { view: t.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
    });
    if (s && this.sceneBG && this.drawBG) {
      g.setPipeline(this.pipes.gbuffer);
      g.setBindGroup(0, this.frameBG);
      g.setBindGroup(1, this.sceneBG);
      g.setVertexBuffer(0, s.vertices);
      g.setIndexBuffer(s.indices, 'uint32');
      for (let i = 0; i < s.slots.length; i++) {
        g.setBindGroup(2, this.drawBG, [i * DRAW_STRIDE]);
        g.drawIndexedIndirect(s.args, i * 20);
      }
    }
    g.end();
    const pass = (label: string, view: GPUTextureView, pipe: GPURenderPipeline, bg: GPUBindGroup) => {
      const p = enc.beginRenderPass({ label, colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }] });
      p.setPipeline(pipe); p.setBindGroup(0, bg); p.draw(3); p.end();
    };
    const B = this.passBGs!;
    pass('mo ink', t.paint.createView(), this.pipes.ink, B.ink);
    const k = this.histIndex;
    pass('mo resolve', t.hist[k].createView(), this.pipes.resolve, B.resolve[k]);
    pass('mo present', this.gpu.context.getCurrentTexture().createView(), this.pipes.present, B.present[k]);
    if (capture) pass('mo capture', t.display.createView(), this.pipes.capture, B.capture[k]);
    d.queue.submit([enc.finish()]);
    this.histIndex = 1 - k;
    this.frameNo++;
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
