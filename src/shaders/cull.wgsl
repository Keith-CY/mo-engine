// Culling and level of detail for every instance, every frame (one invocation per instance).
//
// The level comes from the straight-line distance between the eye and the instance's bounds, with hysteresis: the
// last level is kept until the distance leaves its band by `lod.y`. It is chosen before the frustum test and kept for
// instances out of view, so turning the head never changes a level (only walking does). A visible instance is
// appended to the list of every slot of its level (one slot per mesh of the level; a level may have none); one
// indirect draw per slot draws the list.
//
// Occlusion, in two phases (F.occl.w = 1): `main` draws (pass 0) only the instances that were seen last frame; the
// depth they leave is reduced to a pyramid of its farthest depths (src/shaders/hiz.wgsl); `late` then tests every
// instance in view against it — the ones hidden behind it are not drawn, the ones seen that phase 0 left out are
// drawn now (pass 4, into the same G-buffer), and what each test found is what the next frame's phase 0 draws. The
// test only ever leaves out what lies wholly behind what was drawn, so nothing appears a frame late (no pops), and it
// depends on what is in view, not on the levels: a turn still changes no level.
struct Batch {
  info: vec4u,   // first slot, levels (bits 0–7), the finest level casting shadows (8–15) and the coarsest (16–23), the distance beyond which
                 // it casts no shadow (f32 bits), instance count
  to: vec4f,     // each level is used up to this distance (m)
  bound: vec4f,  // the bounding sphere the level is chosen by, in the instance's space (centre, radius)
  spans: vec4u,  // per level: its first slot (from info.x, bits 0–15) and its number of slots (16–31)
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> inst: array<u32>;
@group(0) @binding(2) var<storage, read> batchOf: array<u32>;
@group(0) @binding(3) var<storage, read> batches: array<Batch>;
@group(0) @binding(4) var<storage, read> slotBase: array<u32>;
@group(0) @binding(5) var<storage, read_write> lodState: array<u32>;
@group(0) @binding(6) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> visible: array<u32>;
// 1 where the instance was seen (not hidden) at the last occlusion test
@group(0) @binding(8) var<storage, read_write> seen: array<u32>;
// the depth pyramid (late only): texel (x, y) of level k the farthest depth over the pixels [x, x + 1) · 2^(k+1)
@group(0) @binding(9) var hiz: texture_2d<f32>;

const NONE = 0xffu;

fn col(i: u32, c: u32) -> vec3f {
  let b = i * 16u + c * 3u;
  return vec3f(bitcast<f32>(inst[b]), bitcast<f32>(inst[b + 1u]), bitcast<f32>(inst[b + 2u]));
}

/** appends instance i to the list of every slot of a level, in pass pi (0 the view, 1 + k cascade k, 3 the view's
 *  dissolving instances, 4 the view's late phase) */
fn emitLevel(B: Batch, level: u32, pi: u32, i: u32) {
  let slots = u32(F.counts.x);
  let passLen = u32(F.counts.y);
  let sp = B.spans[min(level, 3u)];
  let s0 = B.info.x + (sp & 0xffffu);
  for (var m = 0u; m < (sp >> 16u); m++) {
    let s = s0 + m;
    let n = atomicAdd(&args[(pi * slots + s) * 5u + 1u], 1u);
    visible[pi * passLen + slotBase[s] + n] = i;
  }
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
  let levels = B.info.y & 0xffu;
  let h = F.lod.y;
  let st = lodUnpack(lodState[i]);
  let old = st.level;
  var lvl = old;
  if (lvl == NONE) {
    lvl = 0u;
    while (lvl < levels && d > B.to[lvl]) { lvl++; }
  } else {
    while (lvl < levels && d > B.to[min(lvl, 3u)] * (1.0 + h)) { lvl++; }
    while (lvl > 0u && d < B.to[lvl - 1u] * (1.0 - h)) { lvl--; }
  }
  // a new level dissolves in over FADE_FRAMES while the old one dissolves out
  var prev = st.prev;
  var start = st.start;
  if (old != NONE && lvl != old) { prev = old; start = u32(F.eyeDelta.w) & 0xffffu; }
  let fading = prev != NONE && prev < levels && lodAge(start, F.eyeDelta.w) < u32(F.lod.w);
  if (!fading) { prev = NONE; }
  lodState[i] = lvl | (prev << 8u) | (start << 16u);
  if (lvl >= levels && !fading) { return; }

  // (the shadow casters take the level that stays, or the one leaving when none stays, but no finer than the group's
  // shadowFrom)
  let shadowLevel = max(select(prev, lvl, lvl < levels), min((B.info.y >> 8u) & 0xffu, levels - 1u));

  // shadow casters: in a cascade's box (light space, around the eye; the view direction plays no part)
  if ((inst[i * 16u + 15u] & 1u) != 0u && d < bitcast<f32>(B.info.z)) {
    let lp = (F.lightRot * vec4f(c, 0.0)).xyz;
    for (var k = 0u; k < CASCADES; k++) {
      let b = F.shadowBox[k];
      // (the far cascade's texels are metres across: its casters one level coarser, never the impostor)
      let lastCast = (B.info.y >> 16u) & 0xffu;
      let sl = select(shadowLevel, min(shadowLevel + 1u, lastCast), k == CASCADES - 1u && shadowLevel < lastCast);
      if (abs(lp.x - b.x) < b.z + r && abs(lp.y - b.y) < b.z + r && abs(lp.z) < b.w + r) { emitLevel(B, sl, k + 1u, i); }
    }
  }

  for (var k = 0u; k < 5u; k++) {
    let p = F.planes[k];
    if (dot(p.xyz, c) + p.w < -r) { return; }
  }
  // (smaller than a pixel across: not drawn — a far rock, a boat, a house's last level; its distance alone decides)
  if (r < length(c) * F.params.x * 0.5) { return; }
  // (dissolving instances go to their own lists, drawn through the pipeline that may discard: the dither; they are
  // always drawn in the first phase)
  if (fading) {
    if (lvl < levels) { emitLevel(B, lvl, 3u, i); }
    emitLevel(B, prev, 3u, i);
  } else if (lvl < levels && (F.occl.w < 0.5 || seen[i] != 0u)) { emitLevel(B, lvl, 0u, i); }
}

/** whether a sphere (eye-relative centre, radius) lies wholly behind the depth pyramid: its projection's bounding
 *  rectangle (exact for a sphere, Mara & McGuire 2013) read at the level where it spans at most 2 × 2 texels, and its
 *  nearest point farther than the farthest depth there (reverse Z: smaller is farther) */
fn hidden(c: vec3f, r: f32) -> bool {
  let v = (F.viewRot * vec4f(c, 0.0)).xyz;
  let z = -v.z;
  let near = F.params.y;
  if (z - r < near * 2.0) { return false; }
  let P00 = F.proj[0].x; let P11 = F.proj[1].y;
  let tx = sqrt(max(v.x * v.x + z * z - r * r, 0.0));
  let ty = sqrt(max(v.y * v.y + z * z - r * r, 0.0));
  let x0 = (v.x * tx - z * r) / (v.x * r + z * tx);
  let x1 = (v.x * tx + z * r) / (z * tx - v.x * r);
  let y0 = (v.y * ty - z * r) / (v.y * r + z * ty);
  let y1 = (v.y * ty + z * r) / (z * ty - v.y * r);
  // (in pixels, a pixel's margin for the jitter)
  let W = F.viewport.x; let H = F.viewport.y;
  let a = vec2f((x0 * P00 * 0.5 + 0.5) * W - 1.0, (0.5 - y1 * P11 * 0.5) * H - 1.0);
  let b = vec2f((x1 * P00 * 0.5 + 0.5) * W + 1.0, (0.5 - y0 * P11 * 0.5) * H + 1.0);
  let lo = clamp(a, vec2f(0.0), vec2f(W - 1.0, H - 1.0));
  let hi = clamp(b, vec2f(0.0), vec2f(W - 1.0, H - 1.0));
  let size = max(hi.x - lo.x, hi.y - lo.y);
  let levels = u32(F.occl.z);
  let k = min(u32(max(ceil(log2(max(size, 1.0))) - 1.0, 0.0)), levels - 1u);
  let s = exp2(f32(k + 1u));
  let dim = vec2i(textureDimensions(hiz, k)) - 1;
  let p0 = min(vec2i(floor(lo / s)), dim);
  let p1 = min(vec2i(floor(hi / s)), dim);
  let d = min(min(textureLoad(hiz, p0, i32(k)).r, textureLoad(hiz, vec2i(p1.x, p0.y), i32(k)).r),
              min(textureLoad(hiz, vec2i(p0.x, p1.y), i32(k)).r, textureLoad(hiz, p1, i32(k)).r));
  return near / (z - r) < d;
}

/** the occlusion test's second phase (one invocation per instance): after the first phase's G-buffer and the depth
 *  pyramid made from it */
@compute @workgroup_size(64)
fn late(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(F.lod.x)) { return; }
  let B = batches[batchOf[i]];
  let st = lodUnpack(lodState[i]);
  let levels = B.info.y & 0xffu;
  let fading = st.prev != NONE;
  let was = seen[i];
  if (st.level >= levels && !fading) { seen[i] = 0u; return; }
  let X = col(i, 0u); let Y = col(i, 1u); let Z = col(i, 2u); let T = col(i, 3u);
  let c = X * B.bound.x + Y * B.bound.y + Z * B.bound.z + (T - F.eye.xyz);
  let r0 = B.bound.w * max(length(X), max(length(Y), length(Z)));
  for (var k = 0u; k < 5u; k++) {
    let p = F.planes[k];
    if (dot(p.xyz, c) + p.w < -r0) { seen[i] = 0u; return; }
  }
  if (r0 < length(c) * F.params.x * 0.5) { seen[i] = 0u; return; }
  // (ground covers are lifted with distance, up to 0.4 mm a metre: the sphere grows with it)
  let vis = !hidden(c, r0 + 0.0005 * length(c));
  seen[i] = select(0u, 1u, vis);
  if (vis && was == 0u && !fading) { emitLevel(B, st.level, 4u, i); }
}
