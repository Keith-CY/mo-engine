// To the screen (and the capture target): the resolved painting, and on the water the reflection of what stands
// above it. The reflection is found by marching the reflected ray through this frame's depth (so it belongs to the
// geometry and moves rigidly with a turn) and read from the resolved painting itself, softened; it is laid as a wash of
// the reflected darkness that fades away from the shore (the dark woods hang in the water), and at night the lamps'
// light. It is added here, not in the history, so it never feeds back into itself.
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> F: Frame;
@group(0) @binding(2) var gA: texture_2d<f32>;
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

fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.3, 0.55, 0.15)); }

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let p = vec2i(v.pos.xy);
  var c = textureLoad(src, p, 0).rgb;
  let A = textureLoad(gA, p, 0);
  if (u32(A.w + 0.5) != 3u || F.refl.x <= 0.0) { return vec4f(c, 1.0); }
  let size = vec2i(F.viewport.xy);
  let uv = v.pos.xy * F.viewport.zw;
  let depth = textureLoad(gDepth, p, 0);
  let q = F.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let rel = q.xyz / q.w;
  let d = normalize(rel);
  let r = vec3f(d.x, -d.y, d.z);                         // the water lies level
  // march the reflected ray (spacing growing with distance), then refine the crossing
  var hit = vec2f(-1.0);
  var t0 = 0.0;
  var t = 0.3;
  for (var i = 0; i < 40; i++) {
    let Q = rel + r * t;
    let cq = F.viewProj * vec4f(Q, 1.0);
    if (cq.w <= 0.0) { break; }
    let quv = vec2f(cq.x / cq.w * 0.5 + 0.5, 0.5 - cq.y / cq.w * 0.5);
    if (any(quv < vec2f(0.0)) || any(quv > vec2f(1.0))) { break; }
    let sp = vec2i(quv * F.viewport.xy);
    let S = textureLoad(gA, sp, 0);
    // (behind the surface there, not far behind it, and the surface is not the water itself)
    if (S.z > 0.0 && cq.w > S.z && cq.w - S.z < max(1.5, t * 0.12) && u32(S.w + 0.5) != 3u) {
      var a = t0; var b = t;
      for (var k = 0; k < 5; k++) {
        let m = 0.5 * (a + b);
        let cm = F.viewProj * vec4f(rel + r * m, 1.0);
        let muv = vec2f(cm.x / cm.w * 0.5 + 0.5, 0.5 - cm.y / cm.w * 0.5);
        let Sm = textureLoad(gA, vec2i(clamp(muv, vec2f(0.0), vec2f(0.9999)) * F.viewport.xy), 0);
        if (Sm.z > 0.0 && cm.w > Sm.z) { b = m; } else { a = m; }
      }
      let cb = F.viewProj * vec4f(rel + r * b, 1.0);
      hit = vec2f(cb.x / cb.w * 0.5 + 0.5, 0.5 - cb.y / cb.w * 0.5);
      break;
    }
    t0 = t;
    t = t * 1.22 + 0.2;
    if (t > 6000.0) { break; }
  }
  if (hit.x < 0.0) { return vec4f(c, 1.0); }
  // the reflected painting, softened (a few taps up and down), and how far from the shore it lies on the screen
  var rc = vec3f(0.0);
  for (var k = -2; k <= 2; k++) {
    rc += textureSampleLevel(src, lin, hit + vec2f(0.0, f32(k) * 3.0 * F.viewport.w), 0.0).rgb;
  }
  rc /= 5.0;
  let dpx = length((hit - uv) * F.viewport.xy) * 0.5 * (1664.0 / F.viewport.x);
  let edge = smoothstep(0.0, 0.04, min(min(hit.x, 1.0 - hit.x), min(hit.y, 1.0 - hit.y)));
  var rk = exp(-dpx / (70.0 + 50.0 * F.accent.z)) * F.refl.x * edge;
  if (F.refl.y > 0.0) { rk *= exp(-dpx / F.refl.y); }
  // horizontal strokes: the wash a little uneven along the water (fixed to the world)
  let P = rel + F.eye.xyz;
  rk *= 0.75 + 0.5 * vnoise(vec3f(P.x * 0.08, 0.5, P.z * 0.6));
  let dk = 1.0 - lum(rc) / max(lum(F.paper.rgb), 0.05);
  let wash = smoothstep(0.25, 0.75, dk) * 0.75 * rk;
  c = min(c, mix(c, rc, wash));
  // at night the lamps' light runs down into the water
  if (F.water.y > 0.5) { c = max(c, rc * min(rk * 1.2, 1.0) * smoothstep(0.5, 0.9, lum(rc))); }
  return vec4f(c, 1.0);
}
