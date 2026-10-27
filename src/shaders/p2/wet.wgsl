// Painter 2, the last pass: the wet paper (洇). The painting's ink creeps into the damp fibres round it — a soft,
// uneven halo beside every stroke and every edge of a wash, wider where the paper was wetter — and hard edges melt a
// little into what lies beside them, so the lines read as ink on 宣纸, not a pen's. The wetness and the creep's
// directions are anchored to the paper (on the sphere round the eye), so they hold still as the eye turns.
// Before it, on the still lake, the shore's mirror: the painting above the shore line flipped below it, paler, broken
// into horizontal strokes by the ripples and fading away from the shore (ink04's pagoda, ink10's arch closing its ring).
//   W.p: x strength (0 off), y the creep's reach (px at 1664 across), z the softening, w night
//   W.r: x the mirror's gain (0 off), y its fade below the shore line (px at 1664 across)
struct WetP { p: vec4f, r: vec4f };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> W: WetP;
@group(0) @binding(2) var gA: texture_2d<f32>;
@group(0) @binding(3) var src: texture_2d<f32>;
@group(0) @binding(4) var tRidge: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;

struct VOut { @builtin(position) pos: vec4f };
@vertex
fn vs(@builtin(vertex_index) k: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(vec2f(f32((k << 1u) & 2u), f32(k & 2u)) * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

// the shore's reflection on a water pixel (RG.b: px at 1664 up to the shore line above; ≥ 998 none)
fn mirror(c: vec3f, pos: vec2f, size: vec2f, uK: f32, p: vec2i) -> vec3f {
  let rsz = vec2i(textureDimensions(tRidge));
  let up = textureLoad(tRidge, min(p / 2, rsz - 1), 0).b;
  if (up >= 998.0 || up <= 0.0) { return c; }
  let du = up * uK;
  // (the ripples shift each row a little sideways, more the farther below the shore)
  let row = pos.y / (2.5 * uK);
  let wob = (vnoise(vec3f(pos.x / (60.0 * uK), row, 4.2)) - 0.5) * (2.0 + du / (12.0 * uK)) * uK;
  let mp = vec2f(pos.x + wob, pos.y - 2.0 * du);
  if (mp.y < 1.0) { return c; }
  let ma = textureLoad(gA, vec2i(clamp(mp, vec2f(0.0), size - 1.0)), 0);
  let mc = clsOf(ma);
  if (mc == C_WATER || mc == C_SKY) { return c; }
  let m = textureSampleLevel(src, samp, mp / size, 0.0).rgb;
  // broken in long horizontal strokes, fading from the shore down
  let strokes = smoothstep(0.25, 0.65, vnoise(vec3f(pos.x / (55.0 * uK), row * 0.45, 7.3)));
  let a = W.r.x * exp(-up / max(W.r.y, 1.0)) * mix(0.45, 1.0, strokes) * select(1.0, 0.5, W.p.w > 0.5);
  // (only darkening: the reflection is ink laid in the water's tone, never lighter than the water)
  return mix(c, min(c, m), a);
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let p = vec2i(v.pos.xy);
  var c0 = textureLoad(src, p, 0);
  let uv = v.pos.xy / size;
  let uK = size.x / 1664.0;
  let A = textureLoad(gA, p, 0);
  let cls = clsOf(A);
  if (cls == C_WATER && W.r.x > 0.0) { c0 = vec4f(mirror(c0.rgb, v.pos.xy, size, uK, p), c0.a); }
  if (W.p.x <= 0.0) { return c0; }
  let L0 = lum(c0.rgb);
  // the paper's damp: broad patches, wetter and drier, with a finer fibre in them
  let q = relDir(uv) + F.eye.xyz / max(F.look.w, 1.0) * 0.002;
  let wet = smoothstep(0.2, 0.8, 0.65 * vnoise(q * 28.0 + 3.7) + 0.35 * vnoise(q * 95.0 + 11.0));
  // the fibres: a hairy fringe, the creep running farther along some than others
  let fib = 0.6 * vnoise(q * vec3f(380.0, 1500.0, 380.0)) + 0.4 * vnoise(q * vec3f(1400.0, 520.0, 1400.0) + 5.0);
  let reach = W.p.y * uK * (0.8 + 0.4 * wet);
  // a spiral of samples, its turn set by the paper (an even disc, no screen pattern that would crawl)
  let rot = vnoise(q * 700.0) * 6.2832;
  var creep = 0.0;
  var avg = vec3f(0.0); var wsum = 0.0;
  let N = 16;
  for (var i = 0; i < N; i++) {
    let fi = (f32(i) + 0.5) / f32(N);
    let r = reach * sqrt(fi);
    let a = f32(i) * 2.39996 + rot;
    let o = vec2f(cos(a), sin(a)) * r;
    let cs = textureSampleLevel(src, samp, uv + o / size, 0.0).rgb;
    let Ls = lum(cs);
    // ink darker than this pixel creeps toward it, fading with the distance (fibres carry it unevenly)
    let fall = exp(-r / max(reach * (0.15 + 0.85 * fib * fib * 1.6), 1e-3));
    creep = max(creep, max(L0 - Ls, 0.0) * fall);
    let gw = exp(-3.0 * fi);
    avg += cs * gw; wsum += gw;
  }
  avg /= wsum;
  // the 界画 of the buildings keeps a firmer line than the hills, the trees and the ground
  let firm = select(1.0, 0.55, isArch(cls));
  let night = W.p.w > 0.5;
  let k = W.p.x * select(1.0, 0.35, night);
  // the halo: a pale bloom of the neighbour's ink, broken by the fibre
  // (a little everywhere, a little more where the paper was damp: only the lines and the edges of the washes soften,
  // the masses and the white gaps keep their tone)
  let halo = creep * k * 0.5 * (0.7 + 0.3 * wet);
  var c = c0.rgb * max(1.0 - halo / max(L0, 0.04), 0.0);
  // the soft edge: where tones meet, the wet side runs into the other
  let edge = smoothstep(0.02, 0.18, abs(lum(avg) - L0));
  c = mix(c, avg, clamp(W.p.z * k * firm * (0.7 + 0.3 * wet) * edge, 0.0, 0.85));
  return vec4f(c, c0.a);
}
