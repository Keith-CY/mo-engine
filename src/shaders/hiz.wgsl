// The depth pyramid for the occlusion test (src/shaders/cull.wgsl late): level 0 is half the depth buffer's size,
// each texel the farthest depth (reverse Z: the smallest) of the 2 × 2 below it; a level's last row and column also
// take in the odd one left over below, so a texel (x, y) of level k covers the pixels [x, x + 1) · 2^(k+1), and the
// last ones reach the edge.
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var depth: texture_depth_2d;

/** the range of source texels one destination texel covers along an axis */
fn span(x: u32, n: u32, srcN: u32) -> vec2u { return vec2u(2u * x, select(min(2u * x + 1u, srcN - 1u), srcN - 1u, x == n - 1u)); }

@compute @workgroup_size(8, 8)
fn first(@builtin(global_invocation_id) gid: vec3u) {
  let n = textureDimensions(dst);
  if (any(gid.xy >= n)) { return; }
  let sn = textureDimensions(depth);
  let sx = span(gid.x, n.x, sn.x); let sy = span(gid.y, n.y, sn.y);
  var d = 1.0;
  for (var y = sy.x; y <= sy.y; y++) { for (var x = sx.x; x <= sx.y; x++) { d = min(d, textureLoad(depth, vec2u(x, y), 0)); } }
  textureStore(dst, gid.xy, vec4f(d, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn next(@builtin(global_invocation_id) gid: vec3u) {
  let n = textureDimensions(dst);
  if (any(gid.xy >= n)) { return; }
  let sn = textureDimensions(src);
  let sx = span(gid.x, n.x, sn.x); let sy = span(gid.y, n.y, sn.y);
  var d = 1.0;
  for (var y = sy.x; y <= sy.y; y++) { for (var x = sx.x; x <= sx.y; x++) { d = min(d, textureLoad(src, vec2u(x, y), 0).r); } }
  textureStore(dst, gid.xy, vec4f(d, 0.0, 0.0, 0.0));
}
