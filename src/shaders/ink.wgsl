// The painter. Every term below depends on world positions, view directions in the world and the distance from the
// eye — never on where a pixel sits on the screen — so a turn of the head is a rigid motion of the painting
// (docs/ARCHITECTURE.md §1). The terms follow the linan painter (src/ink/painter.js there), made world-anchored.
//
//   paper   fibres and stains from noise on the world view direction (a sphere around the eye), drifting slowly with
//           forward travel
//   sky     paper, and far ranges painted on it (远山: directions only, as far as the sky)
//   washes  light (sun with its shadow, sky) and albedo → ink through the class's fixed curve, more in the shade;
//           a tree crown as clumps, darker underneath, each tree its own depth of ink; laid in a few layers with a
//           darker rim where one ends (墨分五色, 水渍); the ground in tussocks and broad-brush sweeps
//   marks   world-anchored, a constant size on the screen: leaf dots, willow strands and blossom in a frame fixed to
//           each tree (horizontal across the line of sight to its trunk, and up), grass strokes, 皴; fallen petals
//   joints  stone courses, voussoirs and slab joints, drawn on the surface by the G-buffer pass
//   lines   silhouettes and folds where depth and normal change (sky counts as far), and where paving meets ground;
//           weighted per class: contours belong to architecture
//   far     the land beyond a few hundred metres carries a wash of its own (the hills), graded into the haze
//
// Style, per class (4 × vec4, src/ink/style.ts): s0 wash (base, gain, gamma, shadow; a crown: base, crown gain) ·
// s1 line (silhouette, crease, crease threshold, width px) · s2 marks (amount, size px, kind, haze scale) · s3 tint
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var gA: texture_2d<f32>;
@group(0) @binding(2) var gB: texture_2d<f32>;
@group(0) @binding(3) var gC: texture_2d<u32>;
@group(0) @binding(4) var gDepth: texture_depth_2d;
@group(0) @binding(5) var<storage, read> style: array<vec4f>;
@group(0) @binding(6) var<storage, read> inst: array<u32>;

const C_GROUND = 1u; const C_ROCK = 2u; const C_WATER = 3u; const C_BARK = 11u; const C_SMALL = 15u; const C_PAVE = 27u;
fn isArch(c: u32) -> bool { return (c >= 4u && c <= 7u) || c == 13u || c == 19u || c == 21u || c == 22u || c == 25u; }
const M_GRAIN = 1u; const M_LEAF = 2u; const M_VEIL = 3u; const M_GRASS = 4u; const M_PAVE = 5u; const M_ROCK = 6u;
const M_BLOSSOM = 8u;

struct VOut { @builtin(position) pos: vec4f };

@vertex
fn vs(@builtin(vertex_index) k: u32) -> VOut {
  let p = vec2f(f32((k << 1u) & 2u), f32(k & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn loadA(p: vec2i) -> vec4f { return textureLoad(gA, clamp(p, vec2i(0), vec2i(F.viewport.xy) - 1), 0); }
fn vnoise2(p: vec2f) -> f32 { return vnoise(vec3f(p, 0.37)); }
fn h4(p: vec3i) -> vec4f {
  let a = pcg3(bitcast<vec3u>(p));
  let b = pcg3(a ^ vec3u(0x9e3779b9u, 0x85ebca6bu, 0xc2b2ae35u));
  return vec4f(f32(a.x), f32(a.y), f32(a.z), f32(b.x)) * (1.0 / 4294967296.0);
}
fn rot2(v: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(c * v.x - s * v.y, s * v.x + c * v.y); }
/** a mark is on where its hash is below the density (soft, so a changing density fades marks instead of popping them) */
fn markOn(h: f32, dens: f32) -> f32 { return clamp((dens - h) * 16.0, 0.0, 1.0); }

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

// ---- 远山: far ranges painted on the sky, ranges stepping back behind the real horizon, each a wash dark at the
// ridge and fading into mist below. F.ranges = (base elevation, step between ranges, ridge amplitude (rad), count);
// F.rangesB = (azimuth centre, half width (rad, 0: all round), ink, mist fade (rad))
fn ridgeLine(d2: vec2f, k: f32) -> f32 {
  // noise on the unit circle of azimuth (no seam): rounded summits, long stretches where the range sinks into mist
  let c = d2 * (16.0 + 5.0 * k);
  let n = vnoise2(c + k * 11.3) * 0.55 + vnoise2(c * 2.3 + 3.1 + k * 5.0) * 0.3 + vnoise2(c * 5.3 + 9.7 + k) * 0.15;
  let big = vnoise2(d2 * (4.0 + k) + 40.0 + k * 3.7);
  return n * 1.25 - 0.35 + (big - 0.5) * 1.1;
}
fn paintedRanges(dirW: vec3f) -> f32 {
  let R = F.ranges; let RB = F.rangesB;
  if (R.w < 0.5) { return 0.0; }
  let el = asin(clamp(dirW.y, -1.0, 1.0));
  let d2 = normalize(dirW.xz + 1e-6);
  let az = atan2(d2.x, d2.y);
  var win = 1.0;
  if (RB.y > 0.0) {
    let da = abs(fract((az - RB.x) / 6.28318 + 0.5) - 0.5) * 6.28318;
    win = 1.0 - smoothstep(RB.y * 0.3, RB.y * 1.4, da);
  }
  var res = 0.0;
  let n = i32(R.w);
  for (var k = 0; k < 6; k++) {
    if (k >= n) { break; }
    // farthest first: higher, smaller, paler; nearer ranges lower and darker (drawn over them)
    let fk = f32(k);
    let kk = f32(n - 1) - fk;
    let amp = R.z * (0.55 + 0.45 * kk / max(f32(n - 1), 1.0)) * win;
    let ridge = R.x + kk * R.y + amp * ridgeLine(d2, fk) - (1.0 - win) * 0.16;
    if (el < ridge) {
      let below = ridge - el;
      let fade = RB.w * (0.85 + 0.3 * vnoise2(d2 * 4.0 + fk));
      let ink = RB.z * mix(0.28, 1.0, fk / max(f32(n - 1), 1.0));
      // the ridge a little darker, the body a wash with soft vertical texture, the foot lost in mist
      let tq = vec2f(az * 60.0, el * 90.0);
      let tex = 0.5 + 0.5 * (smoothstep(0.35, 0.75, vnoise2(tq + fk * 7.0) * 0.6 + vnoise2(tq * vec2f(2.3, 1.9) + 3.0) * 0.4) - 0.5);
      var w = ink * (0.08 * exp(-below / (fade * 0.12)) + 0.92 * exp(-below / fade) * (0.6 + 0.6 * tex * exp(-below / (fade * 0.6))));
      // a range is not one even strip: long stretches darker or lost in mist, and a soft top edge
      let mot = vnoise2(d2 * (7.0 + 2.0 * fk) + fk * 4.1) * 0.65 + vnoise2(d2 * 23.0 + fk * 1.7) * 0.35;
      w *= (0.35 + 0.95 * smoothstep(0.25, 0.75, mot)) * smoothstep(0.0, F.params.x * 2.5, below);
      res = w;
    }
  }
  return res;
}

// ---- leaf marks in a tree's own frame (p: metres across and up from its trunk; S: the mark spacing; pxu: metres
// per pixel at the tree)
fn willowStrands(p: vec2f, S: f32, pxu: f32, dens: f32, seed: i32) -> f32 {
  var cov = 0.0;
  let gi = floor(p / vec2f(S * 0.5, S));
  for (var j = 0; j <= 3; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = gi + vec2f(f32(i), f32(j));
      let h = h4(vec3i(vec2i(c), seed + 3));
      let on = markOn(h.x, dens);
      if (on <= 0.0) { continue; }
      // a strand hangs from its top, swaying, thinning toward its tip and breaking where the brush lifts
      let top = (c + vec2f(h.y, 0.5 + 0.5 * h.z)) * vec2f(S * 0.5, S);
      let L = S * (3.5 + 3.0 * h.w);
      let t = (top.y - p.y) / L;
      if (t < 0.0 || t > 1.0) { continue; }
      let x = top.x + sin(t * 2.2 + h.w * 6.0) * S * 0.12 + t * t * S * 0.25 * (h.z - 0.5);
      let w = pxu * 0.38 * (1.0 - 0.7 * t);
      var cv = 1.0 - smoothstep(w - pxu * 0.2, w + pxu * 0.6, abs(p.x - x));
      cv *= smoothstep(0.3, 0.5, vnoise2(vec2f(h.y * 50.0, t * 5.0)));
      cov = max(cov, cv * (0.55 + 0.45 * h.w) * (1.0 - 0.75 * t) * on);
    }
  }
  return cov;
}
/** 点叶: clumps of round dots (elongated by `elong`), paper between the clumps */
fn leafDots(p: vec2f, S: f32, pxu: f32, dens0: f32, seed: i32, elong: f32) -> f32 {
  var cov = 0.0;
  let dens = dens0 * smoothstep(0.25, 0.6, vnoise2(p / (S * 3.2) + f32(seed) * 0.37));
  let gi = floor(p / S);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      for (var k = 0; k < 2; k++) {
        let c0 = gi + vec2f(f32(i), f32(j));
        let h = h4(vec3i(vec2i(c0), seed * 2 + k + 11));
        let on = markOn(h.x, dens);
        if (on <= 0.0) { continue; }
        let c = (c0 + h.yz) * S;
        let r = S * (0.22 + 0.16 * h.w);
        var v = rot2(p - c, (h.w - 0.5) * 1.6 + select(-0.5, 0.3, k == 0));
        v.x /= elong;
        let d = length(v) / r;
        let aa = pxu / r;
        let cv = (1.0 - smoothstep(1.0 - aa, 1.0 + aa, d)) * (0.72 + 0.28 * smoothstep(0.5, 1.0, d));   // wet rim
        cov = max(cov, cv * (0.55 + 0.45 * h.x / max(dens, 1e-3)) * on);
      }
    }
  }
  return cov;
}

/** silhouette and fold strength between this pixel and its neighbour n (offset o); the sky lies behind everything */
fn edgeTo(A: vec4f, nC: vec3f, cls: u32, p: vec2i, o: vec2i, s1: vec4f) -> f32 {
  let An = loadA(p + o);
  let nz = select(An.z, 1e6, An.z <= 0.0);
  let jump = (nz - A.z) / max(A.z, 0.5);                       // the neighbour lies behind: a silhouette
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
    // the sky: paper, a breath of wash at the horizon, the far ranges
    let wash = 0.02 * exp(-max(dirW.y, 0.0) * 8.0);
    let rng = 1.0 - exp(-paintedRanges(dirW) * 2.4);
    return vec4f(mix(paper, F.ink.rgb, max(wash, rng)), 1.0);
  }

  let A = textureLoad(gA, p, 0);
  let Bv = textureLoad(gB, p, 0);
  let Cv = textureLoad(gC, p, 0);
  let cls = min(u32(A.w + 0.5), 31u);
  // debug views (?debug=): 1 class, 2 cast shadow and sun, 3 normals, 4 joints
  let dbg = u32(F.counts.w + 0.5);
  if (dbg == 1u) { return vec4f(0.5 + 0.5 * cos(6.2831 * (f32(cls) * 0.137 + vec3f(0.0, 0.33, 0.67))), 1.0); }
  if (dbg == 2u || dbg == 5u) { return vec4f(Bv.w, Bv.x, Bv.y, 1.0); }
  if (dbg == 3u) { return vec4f(octDecode(A.xy) * 0.5 + 0.5, 1.0); }
  if (dbg == 4u) { return vec4f(vec3f(1.0 - bitcast<f32>(Cv.z)), 1.0); }
  let s0 = style[cls * 4u]; let s1 = style[cls * 4u + 1u]; let s2 = style[cls * 4u + 2u]; let s3 = style[cls * 4u + 3u];
  let dist = length(rp.xyz);
  let P = rp.xyz + F.eye.xyz;
  let footprint = dist * F.params.x;          // metres per pixel at this distance
  let nV = octDecode(A.xy);
  let nW = (transpose(F.viewRot) * vec4f(nV, 0.0)).xyz;
  let kind = u32(s2.z + 0.5);
  let sd = f32(Cv.x & 0xffffu) * 0.0137;
  let seed = vec3f(sd, sd * 1.7, sd * 0.3);

  // washes: light and albedo through the class's curve (fixed: no auto levels), more ink in the shade
  // (the ground, the grass and the paving are lit by the sky and darkened only where something casts its shadow on
  // them: a low sun's grazing angle would grey the whole ground — ink02 keeps it pale with the trees' shadows on it)
  let groundLike = cls == C_GROUND || cls == C_SMALL || cls == C_PAVE;
  let sunTerm = select(Bv.x, Bv.w, groundLike);
  let light = clamp(F.look.z * sunTerm + F.look.y * Bv.y, 0.0, 1.0);
  let value = clamp(light * (0.35 + 0.65 * Bv.z), 0.0, 1.0);
  let shade = select(1.0 - smoothstep(0.04, 0.3, Bv.x), 1.0 - Bv.w, groundLike);
  var ink = s0.x + s0.y * pow(1.0 - value, s0.z) + s0.w * shade;
  // the ground in patches a few metres across, bare earth darker than the grass (fixed to the ground; they give way
  // to their mean where they would be only a few pixels)
  if (cls == C_GROUND) {
    let pn = vnoise2(P.xz / 4.5 + 7.3) * 0.6 + vnoise2(P.xz / 1.6 + 2.9) * 0.4;
    ink += 0.32 * (smoothstep(0.4, 0.7, pn) - 0.2) * (1.0 - smoothstep(250.0, 700.0, dist));
  }

  // ---- tree crowns: clumps of foliage in the tree's own frame, each deeper underneath and paler on top, paper
  // between them; each tree its own depth of ink (墨分五色); leaf marks by species
  let crown = kind == M_LEAF || kind == M_VEIL || kind == M_BLOSSOM;
  var leaf = 0.0;
  if (crown) {
    let ii = Cv.y;
    let O = vec3f(bitcast<f32>(inst[ii * 16u + 9u]), bitcast<f32>(inst[ii * 16u + 10u]), bitcast<f32>(inst[ii * 16u + 11u]));
    let r = O - F.eye.xyz;
    let Do = max(length(r), 0.5);
    let fpo = Do * F.params.x;
    let tv = normalize(vec3f(-r.z, 0.0, r.x) + vec3f(1e-5, 0.0, 0.0));
    let lp = vec2f(dot(P - O, tv), P.y - O.y);
    let hs = hash3(vec3i(i32(Cv.x & 0xffffu), 91, 0));
    let tseed = i32(floor(hs * 997.0));
    let under = smoothstep(0.0, 1.0, (O.y + 9.0 - P.y) / 9.0);
    if (kind == M_BLOSSOM) {
      // peach blossom: a breath of wash under dots of pale pink
      ink = s0.x + s0.y * shade;
      leaf = 0.5 * leafDots(lp, fpo * 5.0, fpo, 0.7, tseed, 1.0);
    } else {
      let willow = kind == M_VEIL;
      let S = max(select(2.6, 1.6, willow), fpo * 16.0);
      let sq = select(vec2f(1.0, 1.3), vec2f(1.7, 0.55), willow);
      let g = lp * sq / S + hs * 37.0;
      let gU = g + vec2f(0.0, 0.3);
      let n0 = vnoise2(g) * 0.7 + vnoise2(g * 2.3 + 5.0) * 0.3;
      let nU = vnoise2(gU) * 0.7 + vnoise2(gU * 2.3 + 5.0) * 0.3;
      let body = smoothstep(0.28, 0.52, n0);
      let clumpB = clamp((nU - n0) * 6.0, 0.0, 1.0) * body;
      // groves: the wood gathers into darker and paler groups, not an even carpet of crowns
      let grove = smoothstep(0.28, 0.72, vnoise2(O.xz / 55.0 + 3.3) * 0.7 + vnoise2(O.xz / 21.0 + 8.1) * 0.3);
      let t5 = (0.6 + 0.8 * hs * hs) * mix(0.4, 1.35, grove);
      ink = s0.x + s0.y * (0.16 + 0.55 * shade + 0.2 * under + 0.3 * clumpB) * mix(0.35, 1.0, body) * t5;
      // the leaf marks gather on the clumps' shaded undersides
      let dens = clamp(0.12 + 0.3 * shade + 0.6 * clumpB, 0.0, 0.9) * mix(0.4, 1.0, body);
      if (willow) { leaf = willowStrands(lp, fpo * 16.0, fpo, dens * 0.55, tseed); }
      else { leaf = leafDots(lp, fpo * 5.5, fpo, dens, tseed, 1.5) * (0.55 + 0.45 * clumpB); }
    }
    leaf *= s2.x * (0.7 + 0.6 * hs) * (1.0 - smoothstep(1000.0, 2000.0, Do));
  }

  // ---- the wash laid in a few layers (墨分五色): each step soft, a darker rim where a layer ends (水渍), the steps'
  // edges wandering with a world noise of ~45 px. Crowns and buildings keep most of their smooth wash
  let LAY = F.layering.x;
  if (LAY > 0.0 && cls != C_WATER) {
    let wn = zoomNoise(P, footprint, 45.0, vec3f(5.1, 2.2, 9.7));
    let q = ink * LAY + (wn - 0.5) * 0.6;
    let fl = floor(q);
    let fr = q - fl;
    let layered = (fl + smoothstep(0.38, 0.62, fr)) / LAY;
    let rim = smoothstep(0.45, 0.6, fr) * (1.0 - smoothstep(0.6, 0.95, fr)) * step(0.0, fl) * step(0.02, ink);
    let k = select(select(0.5, 0.2, crown), 0.25, isArch(cls));
    ink = max(mix(ink, layered, k), 0.0) + rim * F.layering.y / LAY * select(select(1.0, 0.3, cls == C_ROCK), 0.0, crown);
  }
  ink += leaf * 0.95;

  // ---- marks on other surfaces: world-anchored, a constant size on the screen, a different pattern per object
  var mark = 0.0;
  if (kind == M_GRAIN) {
    ink *= mix(1.0, 0.55 + 0.9 * zoomNoise(P, footprint, s2.y, seed), s2.x);
  } else if (kind == M_GRASS) {
    // short upright strokes
    let g = zoomNoise(P * vec3f(1.0, 0.35, 1.0), footprint, s2.y, seed);
    mark = smoothstep(0.6, 0.7, g);
  } else if (kind == M_ROCK) {
    // 皴: broken strokes across the rock
    let g = zoomNoise(P * vec3f(1.0, 0.6, 1.0), footprint, s2.y, seed);
    mark = smoothstep(0.62, 0.72, g) * (0.4 + 0.6 * shade);
  }
  ink = max(ink, mark * s2.x);

  // ---- the ground in tussocks (clumps ~0.45 m: lit tops, dark gaps; their mean once smaller than a few pixels) and
  // broad-brush sweeps (horizontal, a little uneven)
  if (cls == C_GROUND || cls == C_SMALL) {
    let k50 = 1.0 - smoothstep(0.45 / 7.0, 0.45 / 2.5, footprint);
    let cl = vnoise(P / 0.45 + vec3f(3.1, 0.0, 7.7));
    ink *= mix(1.0, 0.65 + 0.7 * cl, k50 * 0.7);
  }
  if (!crown && cls != C_WATER) {
    let sweep = zoomNoise(P * vec3f(1.0, 5.0, 1.0) + vec3f(2.3), footprint, 38.0, vec3f(0.0));
    ink *= 0.82 + 0.36 * sweep;
  }

  // ---- joints drawn on the surface (stone courses, voussoirs, slabs), and each block its own tone
  let joint = bitcast<f32>(Cv.z);
  let block = bitcast<f32>(Cv.w);
  if (block >= 0.0) { ink += 0.07 * (block - 0.5); }
  ink = max(ink, joint * select(0.6, 0.42, cls == C_PAVE) * F.ink.w);

  // ---- the far land: hills carry a wash of their own (steeper is darker), graded into the haze below
  var hazeScale = s2.w;
  var lineK = 1.0;
  if (cls == C_GROUND) {
    let far = smoothstep(350.0, 2200.0, dist);
    ink = mix(ink, 0.24 + 0.45 * (1.0 - clamp(nW.y, 0.0, 1.0)) + 0.15 * shade, far);
    hazeScale *= mix(1.0, 6.0, far);
    // the far hills' ridges drawn
    lineK = mix(1.0, 5.0, far);
  }

  // ---- lines: a 1 px cross, and a second ring for lines wider than 1 px; thinner with distance
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

  // ---- into the haze: ink fades with distance (the class can carry further: far hills)
  let haze = exp(-dist / (F.look.x * hazeScale));
  ink = clamp(ink * haze, 0.0, 1.0);

  // ---- colour: the class's tint (blossom pink) under the ink of its marks and lines
  let tintK = s3.w * (1.0 - edge) * (1.0 - 0.6 * leaf);
  let inkCol = mix(F.ink.rgb, s3.rgb, tintK);
  var col = mix(paper, inkCol, ink);
  // fallen petals on the ground in spring: pale pink specks, ~3 cm, scattered in drifts (world cells of 12 cm)
  if ((cls == C_GROUND || cls == C_PAVE) && F.season.x > 0.0) {
    let cell = floor(P.xz / 0.12);
    let h = h4(vec3i(vec2i(cell), 57));
    let drift = smoothstep(0.35, 0.75, vnoise2(P.xz / 6.0 + 1.7)) * select(1.0, 0.35, cls == C_PAVE);
    let on = markOn(h.x, 0.5 * drift * F.season.x);
    let c = (cell + 0.15 + 0.7 * h.yz) * 0.12;
    let r = 0.016 + 0.012 * h.w;
    let d = length(P.xz - c);
    // (smaller than a pixel: a faint pink tint instead of specks)
    let near = 1.0 - smoothstep(r * 0.6, r * 1.6, footprint);
    let speck = (1.0 - smoothstep(r - footprint * 0.7, r + footprint * 0.7, d)) * on * near;
    let tintFar = 0.12 * drift * F.season.x * (1.0 - near);
    col = mix(col, F.season.yzw, clamp(speck * 0.75 + tintFar, 0.0, 1.0) * haze);
  }
  return vec4f(col, 1.0);
}
