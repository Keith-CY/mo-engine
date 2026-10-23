// The terrain's heights on the GPU (src/terrain/chunks.ts): each field a texture, read bilinearly between its
// samples. The shader that includes this binds `nearField` and `farField` (r32float, read with textureLoad).
const VC_TERRAIN = 0x40000u;
const VC_FAR = 0x80000u;
const VC_SKIRT = 0x100000u;

fn fieldLoad(far: bool, p: vec2i) -> f32 {
  if (far) { return textureLoad(farField, p, 0).r; }
  return textureLoad(nearField, p, 0).r;
}

/** a field's height at world (x, z), bilinear */
fn fieldHeight(far: bool, xz: vec2f) -> f32 {
  let A = select(F.fieldNear, F.fieldFar, far);          // origin (x, z), cell, width
  let depth = select(F.fieldNearB.x, F.fieldFarB.x, far);
  let g = (xz - A.xy) / A.z;
  let top = max(vec2i(i32(A.w) - 2, i32(depth) - 2), vec2i(0));
  let g0 = clamp(vec2i(floor(g)), vec2i(0), top);
  let f = clamp(g - vec2f(g0), vec2f(0.0), vec2f(1.0));
  let h00 = fieldLoad(far, g0);
  let h10 = fieldLoad(far, g0 + vec2i(1, 0));
  let h01 = fieldLoad(far, g0 + vec2i(0, 1));
  let h11 = fieldLoad(far, g0 + vec2i(1, 1));
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

struct Lifted { rel: vec3f, nW: vec3f };

/** a terrain grid vertex (eye-relative, on the ground plane) lifted onto its field, with the field's normal there;
 *  `n`: the grid's cells a side, `span`: the chunk's size (m) */
fn liftTerrain(rel0: vec3f, vcls: u32, n: f32, span: f32) -> Lifted {
  let far = (vcls & VC_FAR) != 0u;
  let xz = rel0.xz + F.eye.xz;
  let c = select(F.fieldNear.z, F.fieldFar.z, far);
  var h = fieldHeight(far, xz);
  let nW = normalize(vec3f(fieldHeight(far, xz - vec2f(c, 0.0)) - fieldHeight(far, xz + vec2f(c, 0.0)), 2.0 * c,
                           fieldHeight(far, xz - vec2f(0.0, c)) - fieldHeight(far, xz + vec2f(0.0, c))));
  // a skirt hangs a few cells' worth below the edge
  if ((vcls & VC_SKIRT) != 0u) { h -= 2.0 + 0.5 * span / max(n, 1.0); }
  // the far field sinks under the near one
  if (far && F.fieldNearB.y > 0.5) {
    let A = F.fieldNear;
    let lo = A.xy + A.z * 2.0;
    let hi = A.xy + A.z * (vec2f(A.w, F.fieldNearB.x) - 3.0);
    if (all(xz > lo) && all(xz < hi)) { h -= 60.0; }
  }
  return Lifted(vec3f(rel0.x, h - F.eye.y, rel0.z), nW);
}
