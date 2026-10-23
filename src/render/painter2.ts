/**
 * Painter 2, the still-match painter: linan's painter (the one that made the approved stills) ported pass for pass
 * onto Mo's G-buffer (src/shaders/p2/). Passes, each a full-screen triangle:
 *   tone (full) → ½ blur and ⅛ broad blur · light (½, blurred; ⅛ broad) · edges → jump flood (7 jumps) · ridge (full)
 *   → paint (into the painting target the temporal resolve reads)
 * It reads the look's ink settings as linan's shots give them (scene looks[].ink) and the 纯水墨 style.
 */
import FRAME from '../shaders/frame.wgsl';
import COMMON from '../shaders/p2/common.wgsl';
import TONE_PASS from '../shaders/p2/tone.wgsl';
import BLUR from '../shaders/p2/blur.wgsl';
import LIGHT from '../shaders/p2/light.wgsl';
import EDGE from '../shaders/p2/edge.wgsl';
import JFA from '../shaders/p2/jfa.wgsl';
import RIDGE from '../shaders/p2/ridge.wgsl';
import PAINT from '../shaders/p2/paint.wgsl';

/** linan's shot defaults (src/ink/styles.js SHOT) */
const SHOT: Record<string, unknown> = { near: 40, far: 2600, cunFar: 3500, mi: 900, ridge: 70, ridgeFrom: 900, tone: [1, 1], sky: 0, water: 0.08, waves: 0.25, waveMode: 0, warm: 0, night: 0 };
/** the 纯水墨 style (linan's STYLES.mo over BASE) */
export const STYLE_MO = {
  paperCol: [0.95, 0.925, 0.872], inkAbs: [1.0, 1.0, 0.94], age: 0.25, inkGain: 1.05, washGamma: 1.5, washLo: 0.32, layers: 3.5, pool: 0.45,
  gran: 0.25, line: 1.0, lineW: 0.8, wobble: 1.2, dry: 0.35, cun: 1.0, cunKind: 1, dots: 1.0, moss: 1.0, waves: 1.0,
};
/** the photograph's tone, calibrated against linan's own (?inkDebug=tone) */
export const TONE = { SUN: 2.0, SKY: 2.3, SHOULDER: 0.3, AO: 0.35, GROUND: 0.2, PAVE: 0.25, SKY_HORIZON: 0.86, SKY_ZENITH: 0.78, WATER: 0.45, HAZE: 0.8, HAZE_DIST: 2500, HAZE_AMT: 0.85, VEIL_WILLOW: 0.45, VEIL_BLOSSOM: 0.2 };
const INK_FLOATS = 36 * 4;

interface P2Targets {
  w: number; h: number;
  half: GPUTexture[]; quarter: GPUTexture; eighth: GPUTexture[];
  light: GPUTexture[]; lightQ: GPUTexture; lightE: GPUTexture[];
  edge: GPUTexture; jfa: GPUTexture[]; ridge: GPUTexture;
  passes: { label: string; stage: string; pipe: GPURenderPipeline; bg: GPUBindGroup; view: GPUTextureView }[];
  /** which JFA texture holds the result */
  jfaOut: number;
}

export class Painter2 {
  private pipes!: { tone: GPURenderPipeline; blur: GPURenderPipeline; light: GPURenderPipeline; edge: GPURenderPipeline; jfa: GPURenderPipeline; ridge: GPURenderPipeline; paint: GPURenderPipeline };
  private readonly inkBuf: GPUBuffer;
  private readonly data = new Float32Array(INK_FLOATS);
  private targets?: P2Targets;
  private readonly sampler: GPUSampler;
  /** the look's ink settings (linan's shot object), its camera (the anchor of mist bands and lattices) */
  ink: Record<string, unknown> = {};
  anchor: [number, number, number] = [0, 0, 0];
  anchorDir: [number, number] = [0, 1];
  /** a debug view of the painter (1 wash/detail/mist, 2 tone, 3 density, 4 lines/leaves/皴, 5 ridge, 6 tones) */
  debug = 0;
  /** stages left out (benchmarks: what each costs; their targets keep what they last held) */
  skip = new Set<string>();
  /** parts of the painting left out (benchmarks, bits): 1 lines, 2 dark detail, 4 ground patches, 8 leaf marks, 32 皴 */
  benchFlags = 0;
  /** parts of the painting compiled in (benchmarks: reinit() after a change) */
  features = { ground: true, leaf: true, lines: true, detail: true, cun: true, rock: true, water: true };
  /** compiles the passes again (after `features` change) */
  async reinit(): Promise<void> { await this.init(); this.targets = undefined; this.boundTo = undefined; }

  constructor(private readonly device: GPUDevice) {
    this.inkBuf = device.createBuffer({ label: 'mo p2 ink', size: INK_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  async init(): Promise<void> {
    const d = this.device;
    const consts = Object.entries(TONE).map(([k, v]) => `const TONE_${k} = ${Number(v).toFixed(6)};`).join('\n') + '\n' +
      Object.entries(this.features).map(([k, v]) => `const F_${k.toUpperCase()} = ${v ? 'true' : 'false'};`).join('\n');
    const mk = (label: string, code: string, format: GPUTextureFormat, common = true) => {
      const m = d.createShaderModule({ label, code: common ? `${FRAME}\n${COMMON}\n${consts}\n${code}` : code });
      return d.createRenderPipelineAsync({ label, layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
    };
    const [tone, blur, light, edge, jfa, ridge, paint] = await Promise.all([
      mk('mo p2 tone', TONE_PASS, 'rgba16float'), mk('mo p2 blur', BLUR, 'rgba16float', false), mk('mo p2 light', LIGHT, 'rgba16float'),
      mk('mo p2 edge', EDGE, 'rgba16float'), mk('mo p2 jfa', JFA, 'rgba32uint', false), mk('mo p2 ridge', RIDGE, 'rgba16float'),
      mk('mo p2 paint', PAINT, 'rgba16float'),
    ]);
    this.pipes = { tone, blur, light, edge, jfa, ridge, paint };
  }

  /** the targets and every pass's bind group, for this size and these G-buffer textures */
  private ensure(w: number, h: number, g: { a: GPUTexture; b: GPUTexture; c: GPUTexture; frame: GPUBuffer; inst: GPUBuffer }, out: GPUTexture): P2Targets {
    const key = this.targets;
    if (key && key.w === w && key.h === h && this.boundTo === g.a && this.boundOut === out && this.boundInst === g.inst) return key;
    if (key) for (const t of [...key.half, key.quarter, ...key.eighth, ...key.light, key.lightQ, ...key.lightE, key.edge, ...key.jfa, key.ridge]) t.destroy();
    const d = this.device;
    const tex = (label: string, tw: number, th: number, format: GPUTextureFormat = 'rgba16float') =>
      d.createTexture({ label, size: [Math.max(1, tw), Math.max(1, th)], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const W2 = Math.ceil(w / 2), H2 = Math.ceil(h / 2), W4 = Math.ceil(w / 4), H4 = Math.ceil(h / 4), W8 = Math.ceil(w / 8), H8 = Math.ceil(h / 8);
    const t: P2Targets = {
      w, h,
      half: [tex('mo p2 half 0', W2, H2), tex('mo p2 half 1', W2, H2)], quarter: tex('mo p2 quarter', W4, H4),
      eighth: [tex('mo p2 eighth 0', W8, H8), tex('mo p2 eighth 1', W8, H8)],
      light: [tex('mo p2 light 0', W2, H2), tex('mo p2 light 1', W2, H2)], lightQ: tex('mo p2 light q', W4, H4),
      lightE: [tex('mo p2 light e0', W8, H8), tex('mo p2 light e1', W8, H8)],
      edge: tex('mo p2 edge', w, h), jfa: [tex('mo p2 jfa 0', w, h, 'rgba32uint'), tex('mo p2 jfa 1', w, h, 'rgba32uint')], ridge: tex('mo p2 ridge', W2, H2),
      passes: [], jfaOut: 0,
    };
    const P = this.pipes;
    const ub = (v: number[]) => { const b = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); d.queue.writeBuffer(b, 0, new Float32Array(v)); return b; };
    const bg = (pipe: GPURenderPipeline, res: GPUBindingResource[]) => d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: res.map((resource, binding) => ({ binding, resource })) });
    const fi: GPUBindingResource[] = [{ buffer: g.frame }, { buffer: this.inkBuf }];
    let stage = 'tone';
    const pass = (label: string, pipe: GPURenderPipeline, res: GPUBindingResource[], target: GPUTexture) => t.passes.push({ label, stage, pipe, bg: bg(pipe, res), view: target.createView() });
    // halve src (texel size of src) into dst; blur a ↔ b (k: the step in dst texels)
    const halve = (src: GPUTexture, dst: GPUTexture) => pass('p2 halve', P.blur, [{ buffer: ub([1 / src.width, 1 / src.height, 0, 0]) }, src.createView(), this.sampler], dst);
    const blur = (a: GPUTexture, b: GPUTexture, k: number) => {
      pass('p2 blur', P.blur, [{ buffer: ub([k / a.width, 0, 1, 0]) }, a.createView(), this.sampler], b);
      pass('p2 blur', P.blur, [{ buffer: ub([0, k / a.height, 1, 0]) }, b.createView(), this.sampler], a);
    };
    // the tone (made at ½ res) and its blurs: ½ res (≈3 px) and ⅛ res (≈16 px)
    pass('p2 tone', P.tone, [...fi, g.a.createView(), g.b.createView()], t.half[0]);
    blur(t.half[0], t.half[1], 1.0);
    halve(t.half[0], t.quarter);
    halve(t.quarter, t.eighth[0]);
    blur(t.eighth[0], t.eighth[1], 1.0);
    blur(t.eighth[0], t.eighth[1], 1.5);
    // edges and the jump flood (a seed carries its half width)
    stage = 'lines';
    pass('p2 edge', P.edge, [...fi, g.a.createView(), g.b.createView()], t.edge);
    const zero = d.createTexture({ size: [1, 1], format: 'rgba32uint', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.zero?.destroy(); this.zero = zero;
    pass('p2 jfa', P.jfa, [{ buffer: ub([0, 0, 0, 0]) }, t.edge.createView(), zero.createView()], t.jfa[0]);
    let src = 0;
    // (the lines are a few px wide and their bleed a few more: a reach of 15 px is plenty)
    for (const s of [8, 4, 2, 1]) {
      pass('p2 jfa', P.jfa, [{ buffer: ub([s, 0, 0, 0]) }, t.edge.createView(), t.jfa[src].createView()], t.jfa[1 - src]);
      src = 1 - src;
    }
    t.jfaOut = src;
    // where each pixel sits in its mass
    stage = 'ridge';
    pass('p2 ridge', P.ridge, [...fi, g.a.createView()], t.ridge);
    // the light on the form (½ res, blurred twice; ⅛ broad)
    stage = 'light';
    pass('p2 light', P.light, [...fi, g.a.createView(), g.b.createView()], t.light[0]);
    blur(t.light[0], t.light[1], 1.0);
    blur(t.light[0], t.light[1], 1.6);
    halve(t.light[0], t.lightQ);
    halve(t.lightQ, t.lightE[0]);
    blur(t.lightE[0], t.lightE[1], 1.0);
    blur(t.lightE[0], t.lightE[1], 1.5);
    // the painting
    stage = 'paint';
    pass('p2 paint', P.paint, [...fi, g.a.createView(), g.b.createView(), g.c.createView(), t.half[0].createView(), t.eighth[0].createView(),
      t.edge.createView(), t.jfa[t.jfaOut].createView(), t.ridge.createView(), t.light[0].createView(), t.lightE[0].createView(), this.sampler, { buffer: g.inst }], out);
    this.targets = t;
    this.boundTo = g.a; this.boundOut = out; this.boundInst = g.inst;
    return t;
  }
  private zero?: GPUTexture;
  private boundTo?: GPUTexture;
  private boundOut?: GPUTexture;
  private boundInst?: GPUBuffer;

  /** the painter's uniforms for this frame: the look's ink settings, the style, the camera (the foci projected) */
  private write(w: number, h: number, pxAngle: number, eye: [number, number, number], viewProj: Float32Array, night: boolean): void {
    const I = { ...SHOT, ...this.ink } as Record<string, unknown>;
    const num = (k: string, dflt: number) => (typeof I[k] === 'number' ? (I[k] as number) : dflt);
    const arr = (k: string, n: number, dflt: number[]) => (Array.isArray(I[k]) ? [...(I[k] as number[]), ...dflt].slice(0, n) : dflt.slice(0, n));
    const S = STYLE_MO, f = this.data;
    const fx = this.anchorDir[0], fz = this.anchorDir[1];
    const proj = (p: number[]): number[] => {
      const r = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]], m = viewProj;
      const x = m[0] * r[0] + m[4] * r[1] + m[8] * r[2] + m[12], y = m[1] * r[0] + m[5] * r[1] + m[9] * r[2] + m[13], wq = m[3] * r[0] + m[7] * r[1] + m[11] * r[2] + m[15];
      if (wq <= 0) return [0, 0, 0, 1];
      return [x / wq * 0.5 + 0.5, 0.5 - y / wq * 0.5, p[3], p[4] ?? 0.25];
    };
    const focus = (Array.isArray(I.focus) ? (I.focus as number[][]) : []).slice(0, 2).map(proj);
    const rg = arr('ranges', 8, [0, 0, 0, 0, 0, 0, 0, 0]), deg = Math.PI / 180;
    const bands = (Array.isArray(I.bands) ? (I.bands as number[][]) : []);
    const lv0 = Array.isArray(I.toneLevels) ? (I.toneLevels as number[]) : [];
    const lv = lv0.length >= 10 ? lv0 : [0, 0.25, 0.5, 0.75, 1, 0, 0.25, 0.5, 0.75, 1];
    const vals = [
      w, h, w / 1664, pxAngle,
      -fz, 0, fx, num('grazeFix', 0),
      fx, 0, fz, num('grazeW', 0),
      ...this.anchor, num('groundY', 0),
      S.inkGain, S.washGamma, S.washLo, S.layers,
      S.pool, S.gran, S.line, S.lineW,
      S.wobble, S.dry, S.cun, S.cunKind,
      S.dots, S.moss, S.waves, 1,
      num('near', 40), num('far', 2600), num('cunFar', 3500), num('mi', 900),
      num('ridge', 70), num('ridgeFrom', 900), ...arr('tone', 2, [1, 1]),
      num('sky', 0), num('water', 0.08), num('waves', 0.25), num('waveMode', 0),
      num('warm', 0), night || num('night', 0) ? 1 : 0, num('paperLift', 0), num('lampMirror', 1),
      num('detail', 0), num('trees', 1), num('roofs', 1), num('accent', 0),
      num('rock', 1), num('ground', 1), num('clouds', 0), num('haze', 0),
      num('waterBase', 0), num('match', 0), ...arr('foot', 2, [0, 0]),
      ...arr('fg', 2, [0, 0]), 0, 80,
      num('glow', 0), num('leaf', 1), num('walls', 0), num('groundLift', 0),
      ...arr('veil', 3, [0, 0, 0]), num('cloudBands', 0),
      ...(focus[0] ?? [0, 0, 0, 1]), ...(focus[1] ?? [0, 0, 0, 1]),
      ...arr('mist', 4, [0, 0, 0, 0]),
      ...(bands[0] ?? [0, 0, 0, 0]), ...(bands[1] ?? [0, 0, 0, 0]), ...(bands[2] ?? [0, 0, 0, 0]),
      ...arr('patch', 2, [0, 0]), 0, 0,
      ...arr('tint', 3, [1, 1, 1]), 0,
      ...arr('skyTint', 4, [0, 0, 0, 0]),
      ...arr('moonCol', 4, [0, 0, 0, 0]),
      ...arr('waterRefl', 2, [1, 0]), 0, 0,
      rg[0] * deg, rg[1] * deg, rg[2] * deg, rg[3],
      rg[4] * deg, rg[5] * deg, rg[6], rg[7] * deg,
      ...S.paperCol, S.age,
      ...S.inkAbs, this.debug,
      ...lv.slice(0, 4), lv[4], lv[5], lv[6], lv[7], lv[8], lv[9], lv0.length >= 10 ? 1 : 0, this.benchFlags,
    ];
    if (vals.length !== INK_FLOATS) throw new Error(`[mo p2] ${vals.length} uniform floats, not ${INK_FLOATS}`);
    f.set(vals);
    this.device.queue.writeBuffer(this.inkBuf, 0, f);
  }

  /** records the painter's passes: the G-buffer in, the painting out */
  record(enc: GPUCommandEncoder, g: { a: GPUTexture; b: GPUTexture; c: GPUTexture; frame: GPUBuffer; inst: GPUBuffer }, out: GPUTexture,
    cam: { w: number; h: number; pxAngle: number; eye: [number, number, number]; viewProj: Float32Array; night: boolean },
    tw?: (name: string) => GPURenderPassTimestampWrites | undefined): void {
    const t = this.ensure(cam.w, cam.h, g, out);
    this.write(cam.w, cam.h, cam.pxAngle, cam.eye, cam.viewProj, cam.night);
    // (timed by stage: the first pass of a stage writes its start, the last its end)
    const stages: Record<string, { first: number; last: number }> = {};
    t.passes.forEach((p, i) => { const s = (stages[p.stage] ??= { first: i, last: i }); s.last = i; });
    const marks = new Map<number, GPURenderPassTimestampWrites>();
    for (const [name, s] of Object.entries(stages)) {
      const w = tw?.(name);
      if (!w) continue;
      if (s.first === s.last) { marks.set(s.first, w); continue; }
      marks.set(s.first, { querySet: w.querySet, beginningOfPassWriteIndex: w.beginningOfPassWriteIndex });
      marks.set(s.last, { querySet: w.querySet, endOfPassWriteIndex: w.endOfPassWriteIndex });
    }
    t.passes.forEach((p, i) => {
      if (this.skip.has(p.stage)) return;
      const rp = enc.beginRenderPass({ label: 'mo ' + p.label, timestampWrites: marks.get(i), colorAttachments: [{ view: p.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      rp.setPipeline(p.pipe); rp.setBindGroup(0, p.bg); rp.draw(3); rp.end();
    });
  }
}
