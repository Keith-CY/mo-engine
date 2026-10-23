// To the screen (and the capture target): the resolved painting as it is.
@group(0) @binding(0) var src: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4f };

@vertex
fn vs(@builtin(vertex_index) k: u32) -> VOut {
  let p = vec2f(f32((k << 1u) & 2u), f32(k & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  return vec4f(textureLoad(src, vec2i(v.pos.xy), 0).rgb, 1.0);
}
