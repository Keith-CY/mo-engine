// The frame's uniforms and helpers shared by every pass (prepended to each shader).
//
// Everything on the GPU is relative to the eye: a world position P is drawn as P − eye (camera-relative rendering),
// so viewProj carries the rotation and the projection only.
struct Frame {
  viewRot: mat4x4f,       // world → view rotation
  proj: mat4x4f,          // reverse-Z, infinite, jittered
  viewProj: mat4x4f,      // proj · viewRot
  invViewProj: mat4x4f,   // its inverse: clip → eye-relative world
  prevViewProj: mat4x4f,  // last frame's, unjittered, relative to last frame's eye
  eye: vec4f,             // world eye (xyz), time in s (w)
  eyeDelta: vec4f,        // eye − last frame's eye (xyz), frame number (w)
  sun: vec4f,             // towards the sun (xyz), its strength (w)
  viewport: vec4f,        // width, height, 1 / width, 1 / height
  jitter: vec4f,          // this frame's sub-pixel offset (xy, px), last frame's (zw)
  params: vec4f,          // radians per pixel, near plane (m), frames at rest, 1 when the eye moved this frame
  planes: array<vec4f, 5>,// frustum planes, eye-relative (inside: dot(n, p) + d ≥ 0)
  lod: vec4f,             // instance count, LOD hysteresis (fraction), LOD distance scale, LOD dissolve (frames)
  look: vec4f,            // haze distance (m), sky light, sun light, paper drift (m of forward travel per paper turn)
  paper: vec4f,           // paper colour (rgb), paper texture strength
  ink: vec4f,             // ink colour (rgb), line strength
  lightRot: mat4x4f,      // world → light space (rows: right, up, towards the sun)
  shadowVP: array<mat4x4f, 2>, // eye-relative world → each shadow cascade's clip space
  shadowBox: array<vec4f, 2>,  // each cascade in light space, eye-relative: centre (xy), half size, depth half range
  counts: vec4f,          // slots, visible-list length per pass, cascades, debug view (0 the painting)
  paveField: vec4f,       // the paving map: world origin (x, z), 1 / its extent (x, z)
  ranges: vec4f,          // far ranges painted on the sky: base elevation, step, ridge amplitude (rad), count
  rangesB: vec4f,         // … azimuth centre, half width (rad, 0: all round), ink, mist fade (rad)
  season: vec4f,          // fallen petals on the ground (amount), their colour (rgb)
  layering: vec4f,        // wash layers (墨分五色: 0 off), dark rims where a layer ends (水渍), unused, unused
};

const CASCADES = 2u;
// a change of LOD level dissolves over F.lod.w frames (the old and the new level drawn through complementary halves of
// a dither hashed from the world position; 0: switched at once)

/** an instance's LOD state word: level (bits 0–7, 0xff none), the level it leaves (8–15, 0xff none), frame the change
 *  began (16–31) */
struct LodWord { level: u32, prev: u32, start: u32 };
fn lodUnpack(w: u32) -> LodWord { return LodWord(w & 0xffu, (w >> 8u) & 0xffu, w >> 16u); }
/** frames since `start` (`frame`: the frame number, F.eyeDelta.w) */
fn lodAge(start: u32, frame: f32) -> u32 { return ((u32(frame) & 0xffffu) - start) & 0xffffu; }

fn octEncode(n: vec3f) -> vec2f {
  let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z >= 0.0) { return p; }
  return (1.0 - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0));
}

fn octDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

// pcg3d (Jarzynski & Olano 2020): integer lattice → three well-mixed words
fn pcg3(v0: vec3u) -> vec3u {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

fn hash3(p: vec3i) -> f32 { return f32(pcg3(bitcast<vec3u>(p)).x) * (1.0 / 4294967296.0); }

// value noise, 0 … 1, smooth (quintic)
fn vnoise(p: vec3f) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = mix(mix(hash3(i), hash3(i + vec3i(1, 0, 0)), u.x), mix(hash3(i + vec3i(0, 1, 0)), hash3(i + vec3i(1, 1, 0)), u.x), u.y);
  let b = mix(mix(hash3(i + vec3i(0, 0, 1)), hash3(i + vec3i(1, 0, 1)), u.x), mix(hash3(i + vec3i(0, 1, 1)), hash3(i + vec3i(1, 1, 1)), u.x), u.y);
  return mix(a, b, u.z);
}

fn fbm3(p: vec3f, octaves: i32) -> f32 {
  var s = 0.0; var a = 0.5; var q = p; var n = 0.0;
  for (var k = 0; k < octaves; k++) { s += a * vnoise(q); n += a; a *= 0.5; q = q * 2.03 + vec3f(17.1, 3.7, 9.2); }
  return s / n;
}

// World-anchored noise whose features keep their size on the screen: the octave is chosen from the pixel's footprint
// (m per px at its distance) and blended across octaves as the distance changes ("infinite zoom"). It depends on the
// world position and the distance from the eye only: a turn of the head cannot change it.
fn zoomNoise(P: vec3f, footprint: f32, featurePx: f32, seed: vec3f) -> f32 {
  let level = log2(max(footprint * featurePx, 1e-4));
  let l0 = floor(level);
  let t = level - l0;
  let f0 = exp2(-l0);
  let a = fbm3(P * f0 + seed, 3);
  let b = fbm3(P * f0 * 0.5 + seed * 1.7, 3);
  return mix(a, b, t);
}
