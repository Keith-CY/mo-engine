// Painter 2: halving (a 2 × 2 box through the linear filter) and a separable 9-tap Gaussian (linan's tone and light
// blurs: 5 samples on the linear filter). P.xy: the source texel (uv) for halving, the blur step (uv) for a blur;
// P.z: 0 halve, 1 blur.
struct BlurP { p: vec4f };
@group(0) @binding(0) var<uniform> P: BlurP;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex
fn vs(@builtin(vertex_index) k: u32) -> VOut {
  var o: VOut;
  let q = vec2f(f32((k << 1u) & 2u), f32(k & 2u));
  o.pos = vec4f(q * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(q.x, 1.0 - q.y);
  return o;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let d = P.p.xy;
  if (P.p.z < 0.5) {
    let c = textureSampleLevel(src, samp, v.uv + d * vec2f(-0.5, -0.5), 0.0) + textureSampleLevel(src, samp, v.uv + d * vec2f(0.5, -0.5), 0.0)
          + textureSampleLevel(src, samp, v.uv + d * vec2f(-0.5, 0.5), 0.0) + textureSampleLevel(src, samp, v.uv + d * vec2f(0.5, 0.5), 0.0);
    return c * 0.25;
  }
  var c = textureSampleLevel(src, samp, v.uv, 0.0) * 0.2270270270;
  c += (textureSampleLevel(src, samp, v.uv + d * 1.3846153846, 0.0) + textureSampleLevel(src, samp, v.uv - d * 1.3846153846, 0.0)) * 0.3162162162;
  c += (textureSampleLevel(src, samp, v.uv + d * 3.2307692308, 0.0) + textureSampleLevel(src, samp, v.uv - d * 3.2307692308, 0.0)) * 0.0702702703;
  return c;
}
