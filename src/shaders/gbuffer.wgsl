// The G-buffer: every visible instance once, three colour targets and reverse-Z depth.
//   A  view normal (octahedral, 2) · view depth (m) · class id
//   B  sun light (N·L) · sky light · albedo luminance · 0
//   C  object seed · instance id · 0 · 0
struct Draw {
  visibleBase: u32,
  cls: u32,       // the mesh's class (an instance may override it)
  tone: f32,      // the mesh's albedo luminance when it has none per vertex
  hasTone: u32,
  level: u32,     // the LOD level this draw holds
  cutoff: f32,    // alpha cutoff of its alpha-tested triangles
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d_array;
@group(0) @binding(2) var shadowCmp: sampler_comparison;
@group(0) @binding(3) var alphaTex: texture_2d<f32>;
@group(0) @binding(4) var alphaSamp: sampler;
@group(1) @binding(0) var<storage, read> inst: array<u32>;
@group(1) @binding(1) var<storage, read> visible: array<u32>;
@group(1) @binding(2) var<storage, read> lodState: array<u32>;
@group(2) @binding(0) var<uniform> D: Draw;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) nW: vec3f,
  @location(1) depth: f32,
  @location(2) tone: f32,
  @location(3) @interpolate(flat) cls: u32,
  @location(4) @interpolate(flat) seed: u32,
  @location(5) @interpolate(flat) id: u32,
  @location(6) rel: vec3f,
  // dissolving between levels: how far (0 … 1), and whether this draw is the level coming (1) or going (−1)
  @location(7) @interpolate(flat) fade: vec2f,
  @location(8) uv: vec2f,
  @location(9) @interpolate(flat) alpha: u32,   // 1: alpha-tested
};

fn col(i: u32, c: u32) -> vec3f {
  let b = i * 16u + c * 3u;
  return vec3f(bitcast<f32>(inst[b]), bitcast<f32>(inst[b + 1u]), bitcast<f32>(inst[b + 2u]));
}

@vertex
fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) tone: f32, @location(3) uv: vec2f, @location(4) vcls: u32,
      @builtin(instance_index) ii: u32) -> VOut {
  let i = visible[D.visibleBase + ii];
  let X = col(i, 0u); let Y = col(i, 1u); let Z = col(i, 2u); let T = col(i, 3u);
  let rel = X * p.x + Y * p.y + Z * p.z + (T - F.eye.xyz);
  var o: VOut;
  o.pos = F.viewProj * vec4f(rel, 1.0);
  o.rel = rel;
  // (uniformly scaled instances: the normal goes through the same axes; the scenes keep scale near uniform)
  o.nW = X * n.x + Y * n.y + Z * n.z;
  o.depth = -(F.viewRot * vec4f(rel, 1.0)).z;
  // the class: the instance's, else the triangle's own (the vertex's class word), else the mesh's
  let ic = inst[i * 16u + 12u];
  let vc = vcls & 0xffffu;
  o.cls = select(ic, select(vc, D.cls, vc == 0xffffu), ic == 0xffffffffu);
  o.uv = uv;
  o.alpha = (vcls >> 16u) & 1u;
  o.seed = inst[i * 16u + 13u];
  o.id = i;
  o.tone = select(D.tone, tone, D.hasTone == 1u) * bitcast<f32>(inst[i * 16u + 14u]);
  let st = lodUnpack(lodState[i]);
  o.fade = vec2f(0.0);
  if (st.prev != 0xffu) {
    o.fade = vec2f(f32(lodAge(st.start, F.eyeDelta.w)) / max(F.lod.w, 1.0), select(-1.0, 1.0, D.level == st.level));
  }
  return o;
}

struct GOut {
  @location(0) a: vec4f,
  @location(1) b: vec4f,
  @location(2) c: vec4u,
};

// the sun's shadow at an eye-relative point: the finer cascade that holds it, 4 bilinear comparisons (a 4 × 4 texel
// footprint); 1 beyond the cascades
fn shadowAt(rel: vec3f, nW: vec3f) -> f32 {
  for (var k = 0u; k < CASCADES; k++) {
    let texel = 2.0 * F.shadowBox[k].z / f32(textureDimensions(shadowMap).x);
    let q = F.shadowVP[k] * vec4f(rel + nW * texel * 1.5, 1.0);
    let uv = vec2f(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
    if (all(abs(q.xy) < vec2f(0.97)) && q.z > 0.0 && q.z < 1.0) {
      let t = 0.5 / f32(textureDimensions(shadowMap).x);
      var s = 0.0;
      s += textureSampleCompareLevel(shadowMap, shadowCmp, uv + vec2f(-t, -t), k, q.z);
      s += textureSampleCompareLevel(shadowMap, shadowCmp, uv + vec2f(t, -t), k, q.z);
      s += textureSampleCompareLevel(shadowMap, shadowCmp, uv + vec2f(-t, t), k, q.z);
      s += textureSampleCompareLevel(shadowMap, shadowCmp, uv + vec2f(t, t), k, q.z);
      return s * 0.25;
    }
  }
  return 1.0;
}

@fragment
fn fs(v: VOut, @builtin(front_facing) front: bool) -> GOut {
  // (sampled before any branch: an implicit-derivative sample needs uniform control flow)
  let a = textureSample(alphaTex, alphaSamp, v.uv).r;
  if (v.alpha == 1u && a < D.cutoff) { discard; }
  if (v.fade.y != 0.0) {
    // the dither cell: about a pixel at this distance, fixed to the world
    let cell = max(0.01, v.depth * F.params.x * 1.5);
    let hsh = hash3(vec3i(floor((v.rel + F.eye.xyz) / cell)));
    if ((v.fade.y > 0.0 && hsh > v.fade.x) || (v.fade.y < 0.0 && hsh <= v.fade.x)) { discard; }
  }
  var nW = normalize(v.nW);
  if (!front) { nW = -nW; }
  let nV = normalize((F.viewRot * vec4f(nW, 0.0)).xyz);
  var o: GOut;
  o.a = vec4f(octEncode(nV), v.depth, f32(v.cls));
  let ndl = max(dot(nW, F.sun.xyz), 0.0);
  o.b = vec4f(ndl * select(1.0, shadowAt(v.rel, nW), ndl > 0.0), 0.5 + 0.5 * nW.y, v.tone, 0.0);
  o.c = vec4u(v.seed, v.id, 0u, 0u);
  return o;
}
