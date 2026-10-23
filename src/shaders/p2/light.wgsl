// Painter 2, pass 3b: the light on the form at ½ resolution (blurred after): r = the sun on the surface (0 … 1),
// g = the painter's light: a conventional light from the upper left, toward the viewer (lit tops and left faces, dark
// right and under faces), the way 斧劈 planes are laid. linan takes it in view space; here it is fixed to the look's
// own frame (its right, up and back toward its camera), so a turn of the head does not relight the hills.
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

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(gA));
  let half = ceil(size * 0.5);
  let p = vec2i(clamp(v.pos.xy / half * size, vec2f(0.0), size - 1.0));
  let A = textureLoad(gA, p, 0);
  let B = textureLoad(gB, p, 0);
  if (A.z <= 0.0) { return vec4f(0.6, 0.6, 0.0, 1.0); }
  let s = clamp(B.x, 0.0, 1.5);
  let n = worldNormal(A);
  let L = normalize(-0.55 * K.axisR.xyz + vec3f(0.0, 0.75, 0.0) - 0.35 * K.axisF.xyz);
  let pl = clamp(0.55 + 1.3 * (dot(n, L) - 0.35), 0.0, 1.0);
  return vec4f(s, pl, 0.0, 1.0);
}
