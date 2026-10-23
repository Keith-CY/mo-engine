// The G-buffer: every visible instance once, three colour targets and reverse-Z depth.
//   A  view normal (octahedral, 2) · view depth (m) · class id
//   B  sun light (N·L) · sky light · albedo luminance · 0
//   C  object seed · instance id · 0 · 0
struct Draw {
  visibleBase: u32,
  cls: u32,       // the mesh's class (an instance may override it)
  tone: f32,      // the mesh's albedo luminance when it has none per vertex
  hasTone: u32,
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d_array;
@group(0) @binding(2) var shadowCmp: sampler_comparison;
@group(1) @binding(0) var<storage, read> inst: array<u32>;
@group(1) @binding(1) var<storage, read> visible: array<u32>;
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
};

fn col(i: u32, c: u32) -> vec3f {
  let b = i * 16u + c * 3u;
  return vec3f(bitcast<f32>(inst[b]), bitcast<f32>(inst[b + 1u]), bitcast<f32>(inst[b + 2u]));
}

@vertex
fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) tone: f32, @builtin(instance_index) ii: u32) -> VOut {
  let i = visible[D.visibleBase + ii];
  let X = col(i, 0u); let Y = col(i, 1u); let Z = col(i, 2u); let T = col(i, 3u);
  let rel = X * p.x + Y * p.y + Z * p.z + (T - F.eye.xyz);
  var o: VOut;
  o.pos = F.viewProj * vec4f(rel, 1.0);
  o.rel = rel;
  // (uniformly scaled instances: the normal goes through the same axes; the scenes keep scale near uniform)
  o.nW = X * n.x + Y * n.y + Z * n.z;
  o.depth = -(F.viewRot * vec4f(rel, 1.0)).z;
  let ic = inst[i * 16u + 12u];
  o.cls = select(ic, D.cls, ic == 0xffffffffu);
  o.seed = inst[i * 16u + 13u];
  o.id = i;
  o.tone = select(D.tone, tone, D.hasTone == 1u) * bitcast<f32>(inst[i * 16u + 14u]);
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
