// The painter, first version. Every term below depends on world positions, view directions in the world and the
// distance from the eye — never on where a pixel sits on the screen — so a turn of the head is a rigid motion of the
// painting (docs/ARCHITECTURE.md §1).
//
//   paper   fibres and stains from noise on the world view direction (a sphere around the eye), drifting slowly with
//           forward travel
//   washes  light (sun, sky) and albedo → ink through the class's fixed curve, graded by distance into the haze
//   marks   world-anchored noise with a constant size on the screen (zoomNoise), seeded per object
//   lines   contours where depth, normal or object change (they sit on the geometry, so they move with it)
//
// Style, per class (3 × vec4): s0 wash base, wash gain, wash gamma, line weight · s1 mark amount, mark size (px),
// haze scale, 0 · s2 tint rgb, tint amount
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var gA: texture_2d<f32>;
@group(0) @binding(2) var gB: texture_2d<f32>;
@group(0) @binding(3) var gC: texture_2d<u32>;
@group(0) @binding(4) var gDepth: texture_depth_2d;
@group(0) @binding(5) var<storage, read> style: array<vec4f>;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) k: u32) -> VOut {
  let p = vec2f(f32((k << 1u) & 2u), f32(k & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn loadA(p: vec2i) -> vec4f {
  let s = vec2i(F.viewport.xy) - 1;
  return textureLoad(gA, clamp(p, vec2i(0), s), 0);
}

/** the eye-relative world point under pixel p (a direction, w = 0, for the sky) */
fn relPoint(uv: vec2f, depth: f32) -> vec4f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let q = F.invViewProj * ndc;
  if (depth <= 0.0) { return vec4f(normalize(q.xyz), 0.0); }
  return vec4f(q.xyz / q.w, 1.0);
}

fn paperAt(dirW: vec3f) -> f32 {
  // the sheet lies on a sphere around the eye; it drifts along the walk (the eye's travel, not its turn)
  let drift = F.eye.xyz / max(F.look.w, 1.0);
  let q = dirW + drift * 0.002;
  let grain = vnoise(q * 230.0) - 0.5;
  let fibre = vnoise(q * vec3f(60.0, 900.0, 60.0)) - 0.5;
  let stain = fbm3(q * 6.0 + vec3f(3.1, 7.7, 1.3), 3) - 0.5;
  return 1.0 + F.paper.w * (0.5 * grain + 0.35 * fibre + 0.9 * stain);
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let p = vec2i(v.pos.xy);
  let uv = v.pos.xy * F.viewport.zw;
  let depth = textureLoad(gDepth, p, 0);
  let rp = relPoint(uv, depth);
  let dirW = normalize(rp.xyz);
  let paperTex = paperAt(dirW);
  var paper = F.paper.rgb * paperTex;

  if (depth <= 0.0) {
    // the sky: paper, a faint wash lowest at the horizon
    let wash = 0.06 * exp(-max(dirW.y, 0.0) * 6.0);
    return vec4f(mix(paper, F.ink.rgb, wash), 1.0);
  }

  let A = textureLoad(gA, p, 0);
  let Bv = textureLoad(gB, p, 0);
  let Cv = textureLoad(gC, p, 0);
  let cls = u32(A.w + 0.5);
  let s0 = style[cls * 3u]; let s1 = style[cls * 3u + 1u]; let s2 = style[cls * 3u + 2u];
  let dist = length(rp.xyz);
  let P = rp.xyz + F.eye.xyz;
  let footprint = dist * F.params.x;          // metres per pixel at this distance

  // washes: light and albedo through the class's curve (fixed: no auto levels)
  let light = clamp(F.look.z * Bv.x + F.look.y * Bv.y, 0.0, 1.0);
  let value = clamp(light * (0.35 + 0.65 * Bv.z), 0.0, 1.0);
  var ink = s0.x + s0.y * pow(1.0 - value, s0.z);

  // marks: world-anchored, constant size on the screen, a different pattern per object
  let sd = f32(Cv.x & 0xffffu) * 0.0137;
  let g = zoomNoise(P, footprint, s1.y, vec3f(sd, sd * 1.7, sd * 0.3));
  ink *= mix(1.0, 0.45 + 1.1 * g, s1.x);

  // lines: depth creases and silhouettes, normal creases, object boundaries (1 px cross)
  let nC = octDecode(A.xy);
  var edge = 0.0;
  let offs = array<vec2i, 4>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1));
  var dSum = 0.0;
  for (var k = 0; k < 4; k++) {
    let An = loadA(p + offs[k]);
    dSum += An.z;
    let jump = (An.z - A.z) / max(A.z, 0.5);           // the neighbour lies behind: a silhouette
    edge = max(edge, smoothstep(0.03, 0.12, jump));
    edge = max(edge, smoothstep(0.25, 0.5, 1.0 - dot(nC, octDecode(An.xy))));
    let Cn = textureLoad(gC, clamp(p + offs[k], vec2i(0), vec2i(F.viewport.xy) - 1), 0);
    if (Cn.x != Cv.x && abs(An.z - A.z) > 0.02 * A.z) { edge = max(edge, 0.6); }
  }
  let crease = abs(dSum - 4.0 * A.z) / max(A.z, 0.5);   // the depth's second difference: folds, not slopes
  edge = max(edge, smoothstep(0.02, 0.08, crease));
  ink = max(ink, edge * s0.w * F.ink.w);

  // into the haze: ink fades with distance (the class can carry further: far hills)
  let haze = exp(-dist / (F.look.x * s1.z));
  ink = clamp(ink * haze, 0.0, 1.0);

  let inkCol = mix(F.ink.rgb, s2.rgb, s2.w);
  return vec4f(mix(paper, inkCol, ink), 1.0);
}
