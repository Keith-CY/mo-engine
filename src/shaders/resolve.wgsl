// The temporal resolve: this frame's painting blended into the history, reprojected through depth to where its
// points lay in the last frame. Resting, the blend averages more and more jittered frames (the painting converges in
// place: no other picture is swapped in when the eye stops). Moving, the history is clamped to this frame's 3 × 3
// neighbourhood so nothing trails.
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var cur: texture_2d<f32>;
@group(0) @binding(2) var hist: texture_2d<f32>;
@group(0) @binding(3) var gDepth: texture_depth_2d;
@group(0) @binding(4) var lin: sampler;

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
  let p = vec2i(v.pos.xy);
  let size = vec2i(F.viewport.xy);
  let c = textureLoad(cur, p, 0);
  if (F.eyeDelta.w < 0.5) { return c; }            // the first frame: no history

  var lo = c; var hi = c;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let n = textureLoad(cur, clamp(p + vec2i(i, j), vec2i(0), size - 1), 0);
      lo = min(lo, n); hi = max(hi, n);
    }
  }

  let uv = v.pos.xy * F.viewport.zw;
  let depth = textureLoad(gDepth, p, 0);
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let q = F.invViewProj * ndc;
  var prevClip: vec4f;
  if (depth <= 0.0) {
    prevClip = F.prevViewProj * vec4f(q.xyz, 0.0);            // the sky: a direction, no parallax
  } else {
    prevClip = F.prevViewProj * vec4f(q.xyz / q.w + F.eyeDelta.xyz, 1.0);
  }
  let puv = vec2f(prevClip.x / prevClip.w * 0.5 + 0.5, 0.5 - prevClip.y / prevClip.w * 0.5);
  if (prevClip.w <= 0.0 || any(puv < vec2f(0.0)) || any(puv > vec2f(1.0))) { return c; }

  var h = textureSampleLevel(hist, lin, puv, 0.0);
  let moving = F.params.w > 0.5;
  let rest = F.params.z;
  // resting: a running mean of up to 32 frames; moving: a short exponential tail, clamped to the neighbourhood
  var a = select(max(1.0 / (rest + 1.0), 1.0 / 32.0), 0.18, moving);
  if (moving) { h = clamp(h, lo, hi); }
  return mix(h, c, a);
}
