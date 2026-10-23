// Culling and level of detail for every instance, every frame (one invocation per instance).
//
// The level comes from the straight-line distance between the eye and the instance's bounds, with hysteresis: the
// last level is kept until the distance leaves its band by `lod.y`. It is chosen before the frustum test and kept for
// instances out of view, so turning the head never changes a level (only walking does). A visible instance is
// appended to the list of its (mesh, level) slot; one indirect draw per slot draws the list.
struct Batch {
  info: vec4u,   // first slot, levels, first instance, instance count
  to: vec4f,     // each level is used up to this distance (m)
  bound: vec4f,  // the level-0 mesh's bounding sphere in its own space (centre, radius)
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> inst: array<u32>;
@group(0) @binding(2) var<storage, read> batchOf: array<u32>;
@group(0) @binding(3) var<storage, read> batches: array<Batch>;
@group(0) @binding(4) var<storage, read> slotBase: array<u32>;
@group(0) @binding(5) var<storage, read_write> lodState: array<u32>;
@group(0) @binding(6) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> visible: array<u32>;

const NONE = 0xffu;

fn col(i: u32, c: u32) -> vec3f {
  let b = i * 16u + c * 3u;
  return vec3f(bitcast<f32>(inst[b]), bitcast<f32>(inst[b + 1u]), bitcast<f32>(inst[b + 2u]));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(F.lod.x)) { return; }
  let B = batches[batchOf[i]];
  let X = col(i, 0u); let Y = col(i, 1u); let Z = col(i, 2u); let T = col(i, 3u);
  let c = X * B.bound.x + Y * B.bound.y + Z * B.bound.z + (T - F.eye.xyz);
  let r = B.bound.w * max(length(X), max(length(Y), length(Z)));
  let d = max(0.0, length(c) - r) * F.lod.z;

  // the level, with hysteresis
  let levels = B.info.y;
  let h = F.lod.y;
  var lvl = lodState[i];
  if (lvl == NONE) {
    lvl = 0u;
    while (lvl < levels && d > B.to[lvl]) { lvl++; }
  } else {
    while (lvl < levels && d > B.to[min(lvl, 3u)] * (1.0 + h)) { lvl++; }
    while (lvl > 0u && d < B.to[lvl - 1u] * (1.0 - h)) { lvl--; }
  }
  lodState[i] = lvl;
  if (lvl >= levels) { return; }

  for (var k = 0u; k < 5u; k++) {
    let p = F.planes[k];
    if (dot(p.xyz, c) + p.w < -r) { return; }
  }
  let slot = B.info.x + lvl;
  let n = atomicAdd(&args[slot * 5u + 1u], 1u);
  visible[slotBase[slot] + n] = i;
}
