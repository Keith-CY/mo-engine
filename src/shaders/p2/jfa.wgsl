// Painter 2, pass 2: jump flooding — the nearest line seed for every pixel, weighted by the seed's half width
// (linan's JFA_INIT / JFA_STEP). A seed: x | y << 16, its half width (f32 bits), 1 (none: 0). S.x: the step (0: init).
struct JfaP { s: vec4f };
@group(0) @binding(0) var<uniform> S: JfaP;
@group(0) @binding(1) var edge: texture_2d<f32>;
@group(0) @binding(2) var src: texture_2d<u32>;

struct VOut { @builtin(position) pos: vec4f };
@vertex
fn vs(@builtin(vertex_index) k: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(vec2f(f32((k << 1u) & 2u), f32(k & 2u)) * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4u {
  let p = vec2i(v.pos.xy);
  if (S.s.x < 0.5) {
    let e = textureLoad(edge, p, 0);
    if (e.x > 0.12) { return vec4u(u32(p.x) | (u32(p.y) << 16u), bitcast<u32>(e.y), 0u, 1u); }
    return vec4u(0u);
  }
  let size = vec2i(textureDimensions(src));
  let st = i32(S.s.x);
  var best = vec4u(0u); var bd = 1e9;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = p + vec2i(i, j) * st;
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) { continue; }
      let s = textureLoad(src, q, 0);
      if (s.w == 0u) { continue; }
      let sp = vec2f(f32(s.x & 0xffffu), f32(s.x >> 16u));
      let d = length(sp - vec2f(p)) - bitcast<f32>(s.y);
      if (d < bd) { bd = d; best = s; }
    }
  }
  return best;
}
