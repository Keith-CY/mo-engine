// Painter 2, pass 1: the tone — what linan's painter takes from the photographic frame: the luminance of each
// pixel, albedo × (sun + sky), the far land paling into the haze, the sky and the water bright. Full resolution.
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> K: Ink2;
@group(0) @binding(2) var gA: texture_2d<f32>;
@group(0) @binding(3) var gB: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4f };
@vertex
fn vs(@builtin(vertex_index) k: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(vec2f(f32((k << 1u) & 2u), f32(k & 2u)) * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

/** the photograph's tone of a lit surface: albedo × light through a soft shoulder, display-referred. The ground and
 *  the paving lose most of the sky where something shades them (the canopy over a causeway: no ambient occlusion
 *  here, the cast shadow stands in for it); the terrain's albedo is the photograph's earth, not the G-buffer's default */
fn rawTone(B: vec4f, cls: u32) -> f32 {
  let groundLike = cls == C_GROUND || cls == C_PAVE || cls == C_SMALL;
  var alb = B.z;
  if (cls == C_GROUND && abs(alb - 0.62) < 0.004) { alb = TONE_GROUND; }
  if (cls == C_PAVE && abs(alb - 0.62) < 0.004) { alb = TONE_PAVE; }
  let sky = B.y * select(1.0, mix(TONE_AO, 1.0, B.w), groundLike);
  let t = alb * (TONE_SUN * B.x + TONE_SKY * sky);
  return pow(t / (1.0 + TONE_SHOULDER * t), 1.0 / 2.2);
}
/** the look's baked levels: piecewise linear through its five points (extrapolated at the ends) */
fn levels(t: f32) -> f32 {
  if (K.lv2.z < 0.5) { return t; }
  let xs = array<f32, 5>(K.lv0.x, K.lv0.y, K.lv0.z, K.lv0.w, K.lv1.x);
  let ys = array<f32, 5>(K.lv1.y, K.lv1.z, K.lv1.w, K.lv2.x, K.lv2.y);
  var k = 0;
  for (var i = 1; i < 4; i++) { if (t > xs[i]) { k = i; } }
  let f = (t - xs[k]) / max(xs[k + 1] - xs[k], 1e-4);
  return clamp(mix(ys[k], ys[k + 1], f), 0.0, 1.0);
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let p = vec2i(v.pos.xy);
  let A = textureLoad(gA, p, 0);
  let uv = v.pos.xy / K.res.xy;
  let dirW = relDir(uv);
  if (A.z <= 0.0) {
    // the sky: bright, a little darker overhead; at night the sky is dark and the moon a bright disc
    var t = mix(TONE_SKY_HORIZON, TONE_SKY_ZENITH, smoothstep(0.0, 0.6, dirW.y));
    if (K.sh3.y > 0.5) {
      let ang = acos(clamp(dot(dirW, F.sun.xyz), -1.0, 1.0));
      t = 0.08 + 0.6 * (1.0 - smoothstep(0.016, 0.02, ang)) + 0.25 * exp(-ang / 0.05);
    }
    return vec4f(t, 0.0, 0.0, 1.0);
  }
  let B = textureLoad(gB, p, 0);
  let cls = clsOf(A);
  // (?p2dbg=9: the raw tone, before the look's levels)
  var t = rawTone(B, cls);
  if (u32(K.inkAbs.w + 0.5) != 9u) { t = levels(t); }
  if (cls == C_WATER) { t = select(TONE_WATER, 0.1, K.sh3.y > 0.5); }
  if (cls == C_GLOW && K.sh3.y > 0.5) { t = 0.9; }
  // aerial perspective: the far land pales toward the haze's tone
  let D = A.z;
  t = mix(t, TONE_HAZE, (1.0 - exp(-D / TONE_HAZE_DIST)) * TONE_HAZE_AMT);
  return vec4f(t, 0.0, 0.0, 1.0);
}
