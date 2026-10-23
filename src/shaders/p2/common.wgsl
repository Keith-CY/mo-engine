// The still-match painter (painter 2): linan's painter (src/ink/painter.js there, the one that made the approved
// stills) ported pass for pass onto Mo's G-buffer. Shared by its passes, after frame.wgsl:
//   the painter's uniforms (the look's ink settings as linan's shots give them, the style 纯水墨), the classes,
//   linan's hashes and world-anchored noise, and the camera reconstruction from a pixel and its view depth.
// Conventions: pixel y runs down (linan's GL y runs up: every "up the sheet" there is −y here); px quantities are
// authored at 1664 px across and scaled by uK.
struct Ink2 {
  res: vec4f,       // output width, height, uK (width / 1664), radians per px
  axisR: vec4f,     // the look's horizontal right (xyz; fixed per look: lattices stay put), grazeFix
  axisF: vec4f,     // the look's horizontal forward (xyz), grazeW
  anchor: vec4f,    // the look's own camera (xyz: mist bands, the ground's foreshortening), groundY
  st0: vec4f,       // ink gain, wash gamma, wash low, layers
  st1: vec4f,       // pool, granulation, line ink, line width
  st2: vec4f,       // wobble, dry, 皴, 皴 kind
  st3: vec4f,       // dots, moss, waves, sun intensity
  sh0: vec4f,       // near, far, cunFar, mi
  sh1: vec4f,       // ridge, ridgeFrom, tone (scale, gamma)
  sh2: vec4f,       // sky ink, water, wave amount, wave mode
  sh3: vec4f,       // warm, night, paper lift, lamp mirror
  look: vec4f,      // detail, trees, roofs, accent
  look2: vec4f,     // rock, ground, clouds, haze
  look3: vec4f,     // water base, match, foot width (px), foot amount
  look4: vec4f,     // foreground floor, its height, live (1: the walking painting's settings), water steps
  look5: vec4f,     // glow, leaf, walls, ground lift
  look6: vec4f,     // veil from y0, to y1, amount; cloud bands
  focus0: vec4f,    // a focus: uv (y down), radius (fraction of the height), floor
  focus1: vec4f,
  mistBand: vec4f,  // y0 (fully mist), y1 (clear), from distance, amount
  band0: vec4f,     // mist bands: distance, half width, amount, ceiling (m)
  band1: vec4f,
  band2: vec4f,
  mpatch: vec4f,     // low mist patches between the blocks: size (m), amount
  tint: vec4f,      // the ink's absorbance multiplier (rgb)
  skyTint: vec4f,   // a sky colour (absorbance rgb), amount
  moonCol: vec4f,   // the sun's / moon's column on the water: amount, half width, widening, lantern glints
  waterRefl: vec4f, // the shore's reflection on day water: gain, fade (sheet px, 0 none)
  ranges: vec4f,    // painted far ranges: base elevation, step, amplitude (rad), count
  rangesB: vec4f,   // azimuth centre, half width (rad), ink, mist fade (rad)
  paperCol: vec4f,  // the paper (rgb), age
  inkAbs: vec4f,    // the ink's absorbance (rgb), debug view
  lv0: vec4f,       // the look's tone levels (baked at its viewpoint against linan's auto-levelled photograph):
  lv1: vec4f,       //   five raw tones (lv0.xyzw, lv1.x) → five tones (lv1.yzw, lv2.xy); lv2.z 1 when given
  lv2: vec4f,
};

const C_SKY = 0u; const C_GROUND = 1u; const C_ROCK = 2u; const C_WATER = 3u; const C_ROOF = 4u; const C_WOOD = 5u;
const C_WALL = 6u; const C_STONE = 7u; const C_PINE = 8u; const C_WILLOW = 9u; const C_BROAD = 10u; const C_BARK = 11u;
const C_FIGURE = 12u; const C_GLOW = 13u; const C_BOAT = 14u; const C_SMALL = 15u; const C_BLOSSOM = 16u;
const C_WAVE = 17u; const C_MAPLE = 18u; const C_CITYFAR = 19u; const C_SNOW = 20u; const C_DARK = 21u;
const C_METAL = 22u; const C_GINKGO = 23u; const C_LOTUS = 24u; const C_NICHE = 25u; const C_IVY = 26u;
const C_PAVE = 27u; const C_BLOOM = 28u;

fn isFol(c: u32) -> bool { return c == C_LOTUS || c == C_PINE || c == C_WILLOW || c == C_BROAD || c == C_MAPLE || c == C_GINKGO || c == C_BLOSSOM || c == C_SMALL || c == C_IVY; }
fn isTree(c: u32) -> bool { return c == C_PINE || c == C_WILLOW || c == C_BROAD || c == C_MAPLE || c == C_GINKGO || c == C_BLOSSOM; }
fn isArch(c: u32) -> bool { return c == C_ROOF || c == C_WOOD || c == C_WALL || c == C_STONE || c == C_GLOW || c == C_BOAT || c == C_CITYFAR || c == C_SNOW || c == C_DARK || c == C_METAL; }
fn isLand(c: u32) -> bool { return c == C_GROUND || c == C_ROCK || c == C_FIGURE || c == C_NICHE; }

fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn h33(p: vec3i) -> vec3f { return vec3f(pcg3(bitcast<vec3u>(p)) & vec3u(0xffffffu)) / 16777215.0; }
fn h43(p: vec3i) -> vec4f {
  let a = pcg3(bitcast<vec3u>(p));
  let b = pcg3(a ^ vec3u(0x9e3779b9u));
  return vec4f(vec3f(a & vec3u(0xffffffu)), f32(b.x & 0xffffffu)) / 16777215.0;
}
/** one well-mixed value from an integer lattice point (a cheaper hash than pcg3 for the value noise: 12 operations) */
fn h13(p: vec3i) -> f32 {
  var h = (bitcast<u32>(p.x) * 0x8da6b343u) ^ (bitcast<u32>(p.y) * 0xd8163841u) ^ (bitcast<u32>(p.z) * 0xcb1ab31fu);
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u;
  return f32(h & 0xffffffu) / 16777215.0;
}
fn vnoise3(p: vec3f) -> f32 {
  let fi = floor(p); let i = vec3i(fi); var f = p - fi; f = f * f * (3.0 - 2.0 * f);
  let a = h13(i); let b = h13(i + vec3i(1, 0, 0)); let c = h13(i + vec3i(0, 1, 0)); let d = h13(i + vec3i(1, 1, 0));
  let e = h13(i + vec3i(0, 0, 1)); let g = h13(i + vec3i(1, 0, 1)); let h = h13(i + vec3i(0, 1, 1)); let k = h13(i + vec3i(1, 1, 1));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
fn vnoise2(p: vec2f) -> f32 { return vnoise3(vec3f(p, 0.5)); }
/** world-anchored noise with features ~size metres; size spans octaves smoothly (two power-of-2 levels blended) */
fn lodNoise(P: vec3f, size: f32) -> f32 {
  let l = log2(max(size, 1e-3)); let l0 = floor(l); let t = smoothstep(0.0, 1.0, l - l0);
  // (a level that weighs nothing is not evaluated)
  var r = 0.0;
  if (t < 0.995) { r += (1.0 - t) * vnoise3(P / exp2(l0) + l0 * 7.31); }
  if (t > 0.005) { r += t * vnoise3(P / exp2(l0 + 1.0) + (l0 + 1.0) * 7.31); }
  return r;
}
/** coverage of a tapered segment a → b (widths w0 → w1), aa = soft edge, all in the same units */
fn segCov(p: vec2f, a: vec2f, b: vec2f, w0: f32, w1: f32, aa: f32) -> f32 {
  let pa = p - a; let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  let d = length(pa - ba * h);
  let w = mix(w0, w1, h);
  return smoothstep(w + aa, w - aa, d);
}
fn rot2(v: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(c * v.x - s * v.y, s * v.x + c * v.y); }
/** a mark is drawn where the density passes its own random threshold: a short ramp, so a mark at the edge of the
 *  density fades in and out as it changes instead of popping (linan's moving picture) */
fn markOn(hx: f32, dens: f32) -> f32 { return clamp((dens - hx) * 16.0, 0.0, 1.0); }
fn fmodp(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }

/** fair-weather cumulus, as linan's sky draws them for its photograph: rounded heaps a dozen degrees across, a few
 *  high, low over the horizon and thinning toward the zenith — directions only (as far as the sky: a turn moves them
 *  rigidly, walking does not). → (cover, the shaded base, low on each heap) */
fn cloudsAt(dirW: vec3f) -> vec2f {
  if (dirW.y <= 0.004) { return vec2f(0.0); }
  let el = asin(clamp(dirW.y, -1.0, 1.0));
  let d2 = normalize(dirW.xz + vec2f(1e-6, 0.0));
  // (the azimuth on the unit circle: no seam)
  let q = vec3f(d2 * 4.5, el * 12.0);
  let w = vec2f(fbm3(q * 1.4 + vec3f(7.1, 0.0, 2.0), 3), fbm3(q * 1.4 + vec3f(3.3, 5.0, 0.0), 3)) - 0.5;
  let qw = q + vec3f(0.5 * w.x, 0.5 * w.y, 0.35 * w.x);
  let n = fbm3(qw, 5);
  let band = smoothstep(0.03, 0.1, el) * (1.0 - smoothstep(0.45, 0.85, el));
  let cover = smoothstep(0.53, 0.62, n) * band;
  let nU = fbm3(qw + vec3f(0.0, 0.0, 0.1), 5);
  return vec2f(cover, smoothstep(0.01, 0.07, n - nU) * cover);
}

/** the eye-relative world point under uv (y down) at view depth D, and the direction to it */
fn relDir(uv: vec2f) -> vec3f {
  let q = F.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 1.0, 1.0);
  return normalize(q.xyz / q.w);
}
fn viewFwd() -> vec3f { return -vec3f(F.viewRot[0].z, F.viewRot[1].z, F.viewRot[2].z); }
fn relPosOf(uv: vec2f, D: f32) -> vec3f { let d = relDir(uv); return d * (D / max(dot(d, viewFwd()), 1e-4)); }
fn worldNormal(A: vec4f) -> vec3f { return (transpose(F.viewRot) * vec4f(octDecode(A.xy), 0.0)).xyz; }
fn clsOf(A: vec4f) -> u32 { return select(min(u32(A.w + 0.5), 31u), C_SKY, A.z <= 0.0); }
/** view depth (m); the sky lies behind everything */
fn depthOf(A: vec4f) -> f32 { return select(A.z, 1e6, A.z <= 0.0); }
