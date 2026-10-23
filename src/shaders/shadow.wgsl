// The sun's shadow map: casters chosen by the culling pass for each cascade, depth only; alpha-tested cards are cut by
// their mask (the frame's light matrices; this pass's cascade comes as a uniform).
struct Pass { cascade: u32, visOffset: u32, pad0: u32, pad1: u32 };
struct Draw { visibleBase: u32, cls: u32, tone: f32, hasTone: u32, level: u32, cutoff: f32 };

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> S: Pass;
@group(0) @binding(2) var alphaTex: texture_2d<f32>;
@group(0) @binding(3) var alphaSamp: sampler;
@group(0) @binding(4) var nearField: texture_2d<f32>;
@group(0) @binding(5) var farField: texture_2d<f32>;
@group(1) @binding(0) var<storage, read> inst: array<u32>;
@group(1) @binding(1) var<storage, read> visible: array<u32>;
@group(2) @binding(0) var<uniform> D: Draw;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) alpha: u32,
};

fn col(i: u32, c: u32) -> vec3f {
  let b = i * 16u + c * 3u;
  return vec3f(bitcast<f32>(inst[b]), bitcast<f32>(inst[b + 1u]), bitcast<f32>(inst[b + 2u]));
}

@vertex
fn vs(@location(0) p: vec3f, @location(1) uv: vec2f, @location(2) vcls: u32, @builtin(instance_index) ii: u32) -> VOut {
  let i = visible[S.visOffset + D.visibleBase + ii];
  var rel = col(i, 0u) * p.x + col(i, 1u) * p.y + col(i, 2u) * p.z + (col(i, 3u) - F.eye.xyz);
  if ((vcls & VC_TERRAIN) != 0u) { rel = liftTerrain(rel, vcls, uv.x, length(col(i, 0u))).rel; }
  var o: VOut;
  o.pos = F.shadowVP[S.cascade] * vec4f(rel, 1.0);
  o.uv = uv;
  o.alpha = (vcls >> 16u) & 1u;
  return o;
}

@fragment
fn fs(v: VOut) {
  let a = textureSample(alphaTex, alphaSamp, v.uv).r;
  // (debug view 5: casters without their alpha cut)
  if (v.alpha == 1u && a < D.cutoff && u32(F.counts.w + 0.5) != 5u) { discard; }
}
