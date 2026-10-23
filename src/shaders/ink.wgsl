// The painter. Every term below depends on world positions, view directions in the world and the distance from the
// eye — never on where a pixel sits on the screen — so a turn of the head is a rigid motion of the painting
// (docs/ARCHITECTURE.md §1).
//
//   paper   fibres and stains from noise on the world view direction (a sphere around the eye), drifting slowly with
//           forward travel
//   washes  light (sun with its shadow, sky) and albedo → ink through the class's fixed curve, more in the shade
//   marks   world-anchored, a constant size on the screen (zoomNoise), seeded per object, of the class's kind
//   lines   silhouettes and folds where depth and normal change, and where paving meets ground (they sit on the
//           geometry, so they move with it); weighted per class: contours belong to architecture
//   far     the land beyond a few hundred metres carries a wash of its own (the hills), graded into the haze
//
// Style, per class (4 × vec4, src/ink/style.ts): s0 wash base, gain, gamma, shadow · s1 line silhouette, crease, crease
// threshold, width (px) · s2 marks amount, size (px), kind, haze scale · s3 tint rgb, tint amount
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var gA: texture_2d<f32>;
@group(0) @binding(2) var gB: texture_2d<f32>;
@group(0) @binding(3) var gC: texture_2d<u32>;
@group(0) @binding(4) var gDepth: texture_depth_2d;
@group(0) @binding(5) var<storage, read> style: array<vec4f>;

const C_GROUND = 1u; const C_WATER = 3u; const C_SMALL = 15u; const C_PAVE = 27u;
const M_GRAIN = 1u; const M_LEAF = 2u; const M_VEIL = 3u; const M_GRASS = 4u; const M_PAVE = 5u; const M_ROCK = 6u; const M_MASONRY = 7u;

struct VOut { @builtin(position) pos: vec4f };

@vertex
fn vs(@builtin(vertex_index) k: u32) -> VOut {
  let p = vec2f(f32((k << 1u) & 2u), f32(k & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn loadA(p: vec2i) -> vec4f { return textureLoad(gA, clamp(p, vec2i(0), vec2i(F.viewport.xy) - 1), 0); }
fn loadC(p: vec2i) -> vec4u { return textureLoad(gC, clamp(p, vec2i(0), vec2i(F.viewport.xy) - 1), 0); }

/** the eye-relative world point under pixel p (a direction, w = 0, for the sky) */
fn relPoint(uv: vec2f, depth: f32) -> vec4f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let q = F.invViewProj * ndc;
  if (depth <= 0.0) { return vec4f(normalize(q.xyz), 0.0); }
  return vec4f(q.xyz / q.w, 1.0);
}

fn paperAt(dirW: vec3f) -> f32 {
  // the sheet lies on a sphere around the eye; it drifts along the walk (the eye's travel, not its turn)
  let q = dirW + F.eye.xyz / max(F.look.w, 1.0) * 0.002;
  let grain = vnoise(q * 230.0) - 0.5;
  let fibre = vnoise(q * vec3f(60.0, 900.0, 60.0)) - 0.5;
  let stain = fbm3(q * 6.0 + vec3f(3.1, 7.7, 1.3), 3) - 0.5;
  return 1.0 + F.paper.w * (0.5 * grain + 0.35 * fibre + 0.9 * stain);
}

/** silhouette and fold strength between this pixel and its neighbour n (offset o) */
fn edgeTo(A: vec4f, nC: vec3f, cls: u32, p: vec2i, o: vec2i, s1: vec4f) -> f32 {
  let An = loadA(p + o);
  let jump = (An.z - A.z) / max(A.z, 0.5);                    // the neighbour lies behind: a silhouette
  var e = s1.x * smoothstep(0.03, 0.14, jump);
  if (An.z > 0.0) {
    let fold = 1.0 - dot(nC, octDecode(An.xy));
    e = max(e, s1.y * smoothstep(s1.z, s1.z * 1.6 + 0.05, fold) * (1.0 - smoothstep(0.03, 0.2, abs(jump))));
  }
  // where paving meets the ground: the path's edge
  let cn = u32(An.w + 0.5);
  if ((cls == C_PAVE) != (cn == C_PAVE) && (cn == C_GROUND || cls == C_GROUND) && abs(jump) < 0.05) { e = max(e, 0.55); }
  return e;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let p = vec2i(v.pos.xy);
  let uv = v.pos.xy * F.viewport.zw;
  let depth = textureLoad(gDepth, p, 0);
  let rp = relPoint(uv, depth);
  let dirW = normalize(rp.xyz);
  let paper = F.paper.rgb * paperAt(dirW);

  if (depth <= 0.0) {
    // the sky: paper, a faint wash lowest at the horizon
    let wash = 0.05 * exp(-max(dirW.y, 0.0) * 6.0);
    return vec4f(mix(paper, F.ink.rgb, wash), 1.0);
  }

  let A = textureLoad(gA, p, 0);
  let Bv = textureLoad(gB, p, 0);
  let Cv = textureLoad(gC, p, 0);
  let cls = min(u32(A.w + 0.5), 31u);
  // debug views (?debug=): 1 class, 2 cast shadow and sun, 3 normals
  let dbg = u32(F.counts.w + 0.5);
  if (dbg == 1u) { return vec4f(0.5 + 0.5 * cos(6.2831 * (f32(cls) * 0.137 + vec3f(0.0, 0.33, 0.67))), 1.0); }
  if (dbg == 2u) { return vec4f(Bv.w, Bv.x, Bv.y, 1.0); }
  if (dbg == 3u) { return vec4f(octDecode(A.xy) * 0.5 + 0.5, 1.0); }
  let s0 = style[cls * 4u]; let s1 = style[cls * 4u + 1u]; let s2 = style[cls * 4u + 2u]; let s3 = style[cls * 4u + 3u];
  let dist = length(rp.xyz);
  let P = rp.xyz + F.eye.xyz;
  let footprint = dist * F.params.x;          // metres per pixel at this distance
  let nV = octDecode(A.xy);
  let nW = (transpose(F.viewRot) * vec4f(nV, 0.0)).xyz;

  // washes: light and albedo through the class's curve (fixed: no auto levels), more ink in the shade
  // (the ground, the grass and the paving are lit by the sky and darkened only where something casts its shadow on
  // them: a low sun's grazing angle would grey the whole ground — ink02 keeps it pale with the trees' shadows on it)
  let groundLike = cls == C_GROUND || cls == C_SMALL || cls == C_PAVE;
  let sunTerm = select(Bv.x, Bv.w, groundLike);
  let light = clamp(F.look.z * sunTerm + F.look.y * Bv.y, 0.0, 1.0);
  let value = clamp(light * (0.35 + 0.65 * Bv.z), 0.0, 1.0);
  let shade = select(1.0 - smoothstep(0.04, 0.3, Bv.x), 1.0 - Bv.w, groundLike);
  var ink = s0.x + s0.y * pow(1.0 - value, s0.z) + s0.w * shade;

  // marks: world-anchored, a constant size on the screen, a different pattern per object
  let sd = f32(Cv.x & 0xffffu) * 0.0137;
  let seed = vec3f(sd, sd * 1.7, sd * 0.3);
  let kind = u32(s2.z + 0.5);
  var mark = 0.0;
  if (kind == M_GRAIN) {
    ink *= mix(1.0, 0.55 + 0.9 * zoomNoise(P, footprint, s2.y, seed), s2.x);
  } else if (kind == M_LEAF) {
    // clusters of dots: the crown's foliage, darker in its shade
    let g = zoomNoise(P, footprint, s2.y, seed);
    mark = smoothstep(0.58, 0.68, g) * (0.35 + 0.65 * shade);
  } else if (kind == M_VEIL) {
    // the willow's veil: strands hang, so the pattern runs long down the crown
    let g = zoomNoise(P * vec3f(1.0, 0.18, 1.0), footprint, s2.y, seed);
    ink *= mix(1.0, 0.5 + 1.0 * g, s2.x);
  } else if (kind == M_GRASS) {
    // short upright strokes
    let g = zoomNoise(P * vec3f(1.0, 0.35, 1.0), footprint, s2.y, seed);
    mark = smoothstep(0.6, 0.7, g);
  } else if (kind == M_PAVE && (Cv.z | Cv.w) != 0u) {
    // the slab path: courses across it, each a slab long with jittered ends, split into 2 or 3 slabs; the joints a
    // fine line (about a pixel), fading out where the slabs grow too small to tell apart
    let u = bitcast<f32>(Cv.z);
    let x = bitcast<f32>(Cv.w);
    let r = floor(u);
    var du = 1e3;
    for (var k = -1.0; k <= 1.0; k += 1.0) {
      let b = r + k + 0.18 * (hash3(vec3i(i32(r + k), 7, 1)) - 0.5);
      du = min(du, abs(u - b));
    }
    // the course this point is in, and its slabs across (2 or 3, jittered)
    let rb = select(r, r - 1.0, u < r + 0.18 * (hash3(vec3i(i32(r), 7, 1)) - 0.5));
    let nA = select(2.0, 3.0, hash3(vec3i(i32(rb), 11, 2)) > 0.55);
    var dx = min(x, 1.0 - x) * 3.0;
    for (var j = 1.0; j < nA; j += 1.0) {
      let jx = j / nA + 0.14 * (hash3(vec3i(i32(rb), i32(j), 3)) - 0.5);
      dx = min(dx, abs(x - jx));
    }
    // (in metres: a course is a slab long; the path about 3.2 m across)
    let dm = min(du * 1.15, dx * 3.2);
    let jw = max(footprint * 0.9, 0.012);
    let seen = 1.0 - smoothstep(0.06, 0.18, footprint / 1.15);
    mark = (1.0 - smoothstep(jw * 0.5, jw * 1.6, dm)) * seen;
    ink += 0.04 * (hash3(vec3i(i32(rb), i32(floor(x * nA)), 5)) - 0.5);
  } else if (kind == M_MASONRY) {
    // dressed stone: courses 0.42 m high, blocks 0.9 m long in running bond, laid along the face (the face's own
    // horizontal: across its normal); on near-flat tops the joints run along the world's x
    let t = normalize(select(vec3f(1.0, 0.0, 0.0), vec3f(-nW.z, 0.0, nW.x), abs(nW.y) < 0.8));
    let along = dot(P, t);
    let up = select(dot(P.xz, vec2f(-t.z, t.x)), P.y, abs(nW.y) < 0.8);
    let row = floor(up / 0.42);
    let dv = abs(fract(up / 0.42 + 0.5) - 0.5) * 0.42;
    let off = select(0.0, 0.45, (i32(row) & 1) == 1);
    let dh = abs(fract((along + off) / 0.9 + 0.5) - 0.5) * 0.9;
    let jw = max(footprint * 0.8, 0.01);
    let seen = 1.0 - smoothstep(0.03, 0.09, footprint / 0.42);
    mark = (1.0 - smoothstep(jw * 0.5, jw * 1.6, min(dv, dh))) * seen;
  } else if (kind == M_ROCK) {
    // 皴: broken strokes across the rock
    let g = zoomNoise(P * vec3f(1.0, 0.6, 1.0), footprint, s2.y, seed);
    mark = smoothstep(0.62, 0.72, g) * (0.4 + 0.6 * shade);
  }
  ink = max(ink, mark * s2.x);

  // the far land: hills carry a wash of their own (steeper is darker), graded into the haze below
  var hazeScale = s2.w;
  var lineK = 1.0;
  if (cls == C_GROUND) {
    let far = smoothstep(350.0, 2200.0, dist);
    ink = mix(ink, 0.24 + 0.45 * (1.0 - clamp(nW.y, 0.0, 1.0)) + 0.15 * shade, far);
    hazeScale *= mix(1.0, 6.0, far);
    // the far hills' ridges drawn
    lineK = mix(1.0, 5.0, far);
  }

  // lines: a 1 px cross, and a second ring for lines wider than 1 px; thinner with distance
  var edge = 0.0;
  let ring2 = clamp(s1.w - 1.0, 0.0, 1.0);
  edge = max(edge, edgeTo(A, nV, cls, p, vec2i(1, 0), s1));
  edge = max(edge, edgeTo(A, nV, cls, p, vec2i(-1, 0), s1));
  edge = max(edge, edgeTo(A, nV, cls, p, vec2i(0, 1), s1));
  edge = max(edge, edgeTo(A, nV, cls, p, vec2i(0, -1), s1));
  if (ring2 > 0.0) {
    var e2 = 0.0;
    e2 = max(e2, edgeTo(A, nV, cls, p, vec2i(2, 0), s1));
    e2 = max(e2, edgeTo(A, nV, cls, p, vec2i(-2, 0), s1));
    e2 = max(e2, edgeTo(A, nV, cls, p, vec2i(0, 2), s1));
    e2 = max(e2, edgeTo(A, nV, cls, p, vec2i(0, -2), s1));
    edge = max(edge, e2 * ring2 * 0.7);
  }
  edge *= mix(1.0, 0.6, smoothstep(60.0, 600.0, dist)) * lineK;
  ink = max(ink, edge * F.ink.w);

  // into the haze: ink fades with distance (the class can carry further: far hills)
  let haze = exp(-dist / (F.look.x * hazeScale));
  ink = clamp(ink * haze, 0.0, 1.0);

  let inkCol = mix(F.ink.rgb, s3.rgb, s3.w * (1.0 - edge));
  return vec4f(mix(paper, inkCol, ink), 1.0);
}
