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
const C_ROOF = 4u; const C_GLOW = 13u; const C_PINE = 8u; const C_MAPLE = 18u; const C_GINKGO = 23u; const C_IVY = 26u; const C_BLOOM = 28u;
// pigment absorbances (display-referred, after linan src/ink/styles.js PIGMENT): carbon ink, 赭石 ochre, 花青 indigo,
// 藤黄 gamboge, 朱砂 cinnabar
const P_INK = vec3f(0.92, 0.98, 1.06); const P_ZHE = vec3f(0.18, 0.42, 0.85); const P_HUA = vec3f(0.95, 0.55, 0.28);
const P_TENG = vec3f(0.03, 0.12, 0.95); const P_ZHU = vec3f(0.06, 0.85, 0.80);

/** clouds on a layer ~2 km up, seen from the eye (fixed to the world, so a turn moves them rigidly): (coverage, the
 *  shaded underside) */
/** ripple lines on the water (mode 0: short bowed strokes, sparse; 1: 水纹, rows of shallow arcs), in the frame of the
 *  look's viewpoint (fixed per look, so a turn does not slide them), rows spread so they keep a screen spacing
 *  (sinG: the sine at which the eye sees the water there) */
fn ripples(P: vec3f, fp: f32, dens: f32, mode: f32, sinG: f32) -> f32 {
  let f2 = normalize(F.shotDir.xy + vec2f(1e-6, 0.0));
  let r2 = vec2f(f2.y, -f2.x);
  let uK = F.viewport.x / 1664.0;
  let l = log2(fp * select(46.0, 22.0, mode > 0.5) * uK);
  let l0 = floor(l);
  let t = smoothstep(0.0, 1.0, l - l0);
  let q = vec2f(dot(P.xz, r2), dot(P.xz, f2));
  var cov = 0.0;
  for (var L = 0; L < 2; L++) {
    let lev = l0 + f32(L);
    let S = exp2(lev);
    let Sv = S / max(sinG, 0.02) * select(0.35, 0.45, mode > 0.5);
    let gi = floor(q / vec2f(S, Sv));
    var c0 = 0.0;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let cc = gi + vec2f(f32(i), f32(j));
        let h = h4(vec3i(vec2i(cc), i32(lev) * 5 + 3));
        let on = select(markOn(h.x, dens), 1.0, mode > 0.5);
        if (on <= 0.0) { continue; }
        let ox = select(h.y, 0.5 * (abs(cc.y) % 2.0), mode > 0.5);
        let v = q - (cc + vec2f(ox, 0.5)) * vec2f(S, Sv);
        var cv = 0.0;
        if (mode > 0.5) {
          let u = v.x / (S * 0.5);
          if (abs(u) > 1.0) { continue; }
          let wpx = 0.5 * (0.6 + 0.8 * h.z) * (1.0 - u * u * 0.7) * uK;
          let dpx = abs(v.y + (1.0 - u * u) * Sv * 0.35) * sinG / fp;
          cv = (1.0 - smoothstep(wpx - 0.3, wpx + 0.5, dpx)) * markOn(h.x, dens * 1.4);
        } else {
          let u = v.x / (S * (0.35 + 0.4 * h.z));
          if (abs(u) > 1.0) { continue; }
          let wpx = 0.5 * (1.0 - u * u) * uK;
          let dpx = abs(v.y - (1.0 - u * u) * Sv * 0.12 * (h.w - 0.5)) * sinG / fp;
          cv = 1.0 - smoothstep(wpx - 0.3, wpx + 0.5, dpx);
        }
        c0 = max(c0, cv * (0.5 + 0.5 * h.w) * on);
      }
    }
    cov += c0 * select(t, 1.0 - t, L == 0);
  }
  return cov;
}

/** 水纹: rows of drawn wave lines over the whole water (马远《水图》), rows kept ~rowPx apart on the screen, in the
 *  frame of the look's viewpoint, broken into strokes */
fn waveRows(P: vec3f, fp: f32, sinG: f32, dens: f32, amp: f32, rowPx: f32) -> f32 {
  let f2 = normalize(F.shotDir.xy + vec2f(1e-6, 0.0));
  let r2 = vec2f(f2.y, -f2.x);
  let q = vec2f(dot(P.xz, r2), dot(P.xz, f2));
  let uK = F.viewport.x / 1664.0;
  let pxPerV = sinG / max(fp, 1e-5);
  let l = log2(rowPx * uK / pxPerV);
  let l0 = floor(l);
  let t = smoothstep(0.0, 1.0, l - l0);
  var cov = 0.0;
  for (var L = 0; L < 2; L++) {
    let lev = l0 + f32(L);
    let Sv = exp2(lev);
    let Su = Sv * 4.5 * max(sinG, 0.03);
    let ph = vnoise2(vec2f(q.x / (Su * 5.0), q.y / (Sv * 4.0)) + lev) * 2.0;
    let g = q.y / Sv + amp * abs(sin(3.14159 * (q.x / Su + ph)));
    let k = floor(g + 0.5);
    let dpx = abs(g - k) * Sv * pxPerV;
    let w = 0.45 * uK;
    var c = 1.0 - smoothstep(w - 0.3 * uK, w + 0.6 * uK, dpx);
    c *= smoothstep(1.0 - dens, 1.0 - dens + 0.15, vnoise2(vec2f(q.x / (Su * 1.7), k * 1.37 + lev * 3.0)));
    cov += c * select(t, 1.0 - t, L == 0);
  }
  return cov;
}

/** a night painting: the day's painting graded into the night's indigo (paper a deep blue, ink near black-blue) */
fn nightGrade(c: vec3f) -> vec3f {
  let l = dot(c, vec3f(0.3, 0.55, 0.15));
  return mix(vec3f(0.035, 0.045, 0.085), vec3f(0.3, 0.37, 0.5), smoothstep(0.05, 0.98, l));
}

fn cloudsAt(dirW: vec3f) -> vec2f {
  if (dirW.y <= 0.01) { return vec2f(0.0); }
  let H = 2000.0;
  let q = (F.eye.xz + dirW.xz * ((H - F.eye.y) / dirW.y)) / 900.0;
  let n = fbm3(vec3f(q, 0.7), 4);
  let cover = smoothstep(0.44, 0.58, n) * smoothstep(0.01, 0.08, dirW.y);
  // the underside: where the noise falls toward the sun's side below the cloud, a grey wash
  let nU = fbm3(vec3f(q + vec2f(0.0, -0.06), 0.7), 4);
  return vec2f(cover, clamp((n - nU) * 6.0, 0.0, 1.0) * cover);
}
/** cloud bands: long soft streaks low in the sky (directions only) */
fn cloudBandsAt(dirW: vec3f) -> f32 {
  let el = asin(clamp(dirW.y, -1.0, 1.0));
  let az = atan2(dirW.x, dirW.z);
  let b = vnoise2(vec2f(az * 3.0, el * 70.0)) * 0.6 + vnoise2(vec2f(az * 9.0, el * 160.0)) * 0.4;
  return smoothstep(0.55, 0.75, b) * smoothstep(0.01, 0.04, el) * (1.0 - smoothstep(0.08, 0.2, el));
}

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
      if (F.lines.z > 0.5) {
        // a snowy range: left as paper, drawn by its ridge line, a few crevices running down from it and a pale grey on
        // the shaded side of each spur; the farther range a pale grey wash lost in mist (q: pixels on the sky sphere)
        let qp = vec2f(az, el) / F.params.x;
        let line = (1.0 - smoothstep(0.4, 1.8, below / F.params.x)) * (0.55 + 0.45 * smoothstep(0.3, 0.6, vnoise2(qp / 30.0 + fk)));
        let gs = smoothstep(0.4, 0.6, vnoise2(qp / 70.0 + fk * 5.0));
        let c1 = smoothstep(0.74, 0.86, vnoise2(vec2f((qp.x + 0.7 * qp.y) / 3.0, qp.y / 45.0) + fk * 13.0));
        let c2 = smoothstep(0.74, 0.86, vnoise2(vec2f((qp.x - 0.7 * qp.y) / 3.0, qp.y / 45.0) + fk * 17.0));
        let crev = mix(c1, c2, gs) * smoothstep(0.3, 0.6, vnoise2(qp / 35.0 + 3.0 + fk));
        let sp0 = vnoise2(vec2f((qp.x + 0.8 * qp.y) / 38.0, qp.y / 200.0) + fk * 7.0);
        let spur = smoothstep(0.5, 0.62, sp0) * (0.6 + 0.4 * vnoise2(qp / 12.0));
        let dn = exp(-below / (fade * 0.9));
        let mo2 = vnoise2(d2 * 9.0 + fk * 4.1);
        w = select(ink * 0.22 * exp(-below / fade) * (0.4 + 0.9 * mo2) * smoothstep(0.0, F.params.x * 3.0, below),
                   ink * (0.9 * line + 0.6 * crev * exp(-below / (fade * 0.45)) + 0.28 * spur * dn), kk < 0.5);
      }
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

/** 米点: soft horizontal blobs, the far woods (p: metres on the surface, S: the spacing) */
fn miDots(p: vec2f, S: f32, dens: f32, seed: i32) -> f32 {
  var cov = 0.0;
  let cell = vec2f(S * 1.3, S * 0.7);
  let gi = floor(p / cell);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cc = gi + vec2f(f32(i), f32(j));
      let h = h4(vec3i(vec2i(cc), seed + 23));
      let on = markOn(h.x, dens);
      if (on <= 0.0) { continue; }
      let v = (p - (cc + h.yz) * cell) / (S * vec2f(0.62, 0.3) * (0.8 + 0.4 * h.w));
      cov += (1.0 - smoothstep(0.45, 1.0, length(v))) * (0.35 + 0.4 * h.w) * on;
    }
  }
  return min(cov, 1.0);
}
/** 米点 on the far land: the lattice in metres, two sizes blended so the dots keep ~9 px on the screen; the face's own
 *  plane picks the projection (fixed to the ground) */
fn farWoods(P: vec3f, nW: vec3f, fp: f32, dens: f32) -> f32 {
  let l = log2(max(fp * 9.0, 0.5));
  let l0 = floor(l);
  let t = smoothstep(0.0, 1.0, l - l0);
  let ax = abs(nW.x) > abs(nW.z);
  let p = select(vec2f(P.x, P.y), vec2f(P.z, P.y), ax);
  let a = miDots(p, exp2(l0), dens, i32(l0) * 7);
  let b = miDots(p, exp2(l0 + 1.0), dens, i32(l0 + 1.0) * 7);
  return mix(a, b, t);
}

// ---- rock (after linan's ink-match rock): planes, fissures and dry streaks on the face's own vertical plane — the one
// across the larger horizontal component of its normal (fixed to the rock, so a turn moves them rigidly)
fn rockPlane(P: vec3f, nW: vec3f) -> vec3f {
  let ax = abs(nW.x) > abs(nW.z);
  let q = select(vec2f(P.x, P.y), vec2f(P.z, P.y), ax);
  let side = select(sign(nW.z + 1e-6), sign(nW.x + 1e-6), ax);
  return vec3f(q, side);
}
/** 斧劈 facets: a Voronoi partition of the face plane (cells taller than wide, sheared down the slope) → (the cell's
 *  value, metres to its border) */
fn facetCell(q0: vec2f, S: f32, shear: f32, seed: i32) -> vec2f {
  var q = q0;
  q.x += shear * q.y;
  let g = q / vec2f(S, S * 1.6);
  let gi = floor(g);
  let gf = g - gi;
  var d1 = 9.0; var d2 = 9.0; var id = gi;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let o = vec2f(f32(i), f32(j));
      let h = h4(vec3i(vec2i(gi + o), seed));
      let d = length((o + 0.1 + 0.8 * h.xy - gf) * vec2f(1.0, 1.6));
      if (d < d1) { d2 = d1; d1 = d; id = gi + o; } else if (d < d2) { d2 = d; }
    }
  }
  return vec2f(hash3(vec3i(vec2i(id), seed + 5)), (d2 - d1) * 0.5 * S);
}
/** two facet sizes (big planes ~bigPx on the screen, small ~bigPx / 3), blended by distance → (plane value −0.5 … 0.5,
 *  border line: only some plane edges are drawn, a cut, a fold; the rest are left to the change of tone) */
fn facets(P: vec3f, nW: vec3f, fp: f32, bigPx: f32) -> vec2f {
  let rp = rockPlane(P, nW);
  let q = rp.xy;
  let l = log2(fp * bigPx);
  let l0 = floor(l);
  let t = smoothstep(0.0, 1.0, l - l0);
  var r = vec2f(0.0);
  for (var L = 0; L < 2; L++) {
    let lev = l0 + f32(L);
    let S = exp2(lev);
    let a = facetCell(q, S, 0.35 * rp.z, 401 + i32(lev) * 3);
    let b = facetCell(q + 7.3, S * 0.36, -0.25 * rp.z, 433 + i32(lev) * 3);
    let line = (1.0 - smoothstep(fp * 0.4, fp * 1.3, a.y)) * step(0.62, a.x) * smoothstep(0.35, 0.6, vnoise2(q / (S * 0.7) + 3.0));
    r += vec2f((a.x - 0.5) * 0.65 + (b.x - 0.5) * 0.35, line) * select(t, 1.0 - t, L == 0);
  }
  return r;
}
/** the vertical fissures of a limestone face: long wandering cracks down the face plane, a column of rock between two
 *  of them, ~38 px columns → (the crack's ink, the shade of the step beside it) */
fn fissures(P: vec3f, nW: vec3f, fp: f32) -> vec2f {
  let q = rockPlane(P, nW).xy;
  let px = max(fp, 1e-4);
  let l = log2(px * 38.0);
  let l0 = floor(l);
  let t = smoothstep(0.0, 1.0, l - l0);
  var r = vec2f(0.0);
  for (var L = 0; L < 2; L++) {
    let lev = l0 + f32(L);
    let S = exp2(lev);
    let ci = floor(q.x / S);
    var on = 0.0; var side = 0.0;
    for (var i = -1; i <= 1; i++) {
      let c = ci + f32(i);
      let h = h4(vec3i(i32(c), i32(lev) + 64, 913));
      let x = (c + 0.2 + 0.6 * h.x) * S + S * 0.3 * (vnoise2(vec2f(c * 7.1, q.y / (S * 1.7))) - 0.5) + S * 0.07 * (vnoise2(vec2f(c * 3.3, q.y / (S * 0.35))) - 0.5);
      var seg = smoothstep(0.3, 0.5, vnoise2(vec2f(c * 5.7 + 2.0, q.y / (S * 3.0) + h.y * 9.0))) * step(0.3, h.z);
      let d = (q.x - x) / px;
      let w = (0.25 + 0.9 * h.y * h.y) * seg;
      on = max(on, (1.0 - smoothstep(w - 0.3, w + 0.8, abs(d))) * seg * (0.55 + 0.45 * h.z));
      side = max(side, step(0.0, d) * exp(-d / (5.0 + 16.0 * h.w)) * seg);
    }
    r += vec2f(on, side) * select(t, 1.0 - t, L == 0);
  }
  return r;
}
/** dry vertical streaks of the side brush on a face, gathered in groups (~26 px), denser in shade */
fn rockStreaks(P: vec3f, nW: vec3f, fp: f32, dens: f32) -> f32 {
  let q = rockPlane(P, nW).xy;
  let l = log2(fp * 26.0);
  let l0 = floor(l);
  var c = vec2f(0.0);
  for (var L = 0; L < 2; L++) {
    let S = exp2(l0 + f32(L));
    let u = vec2f(q.y / S, q.x / (S / 5.5));
    let n = vnoise2(u + (l0 + f32(L)) * 17.0) * 0.62 + vnoise2(u * vec2f(2.1, 1.7) + 5.3) * 0.38;
    let cl = vnoise2(q / (S * 2.6) + (l0 + f32(L)) * 3.1);
    let th = 1.0 - dens * (0.45 + 0.8 * cl);
    c[L] = smoothstep(th, th + 0.06, n) * (0.7 + 0.3 * smoothstep(0.2, 0.7, vnoise2(u * vec2f(0.5, 1.5) + 9.0)));
  }
  return mix(c.x, c.y, smoothstep(0.0, 1.0, l - l0));
}

/** the lit albedo a G-buffer texel shows (−1: sky) */
fn litAlbedo(p: vec2i) -> f32 {
  let q = clamp(p, vec2i(0), vec2i(F.viewport.xy) - 1);
  if (textureLoad(gA, q, 0).z <= 0.0) { return -1.0; }
  let b = textureLoad(gB, q, 0);
  return clamp(F.look.z * b.x + F.look.y * b.y, 0.05, 1.5) * b.z;
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
    // the sky: paper, a breath of wash at the horizon (the night sky's ink at night), the far ranges, clouds
    let night = F.water.y > 0.5;
    let sunAng = acos(clamp(dot(dirW, F.sun.xyz), -1.0, 1.0));
    let up = smoothstep(0.0, 0.45, dirW.y);
    var wash = 0.02 * exp(-max(dirW.y, 0.0) * 8.0);
    if (night) { wash = F.water.z * 0.5 * (1.0 - 0.35 * (1.0 - up)) * (1.0 - 0.6 * exp(-sunAng / 0.08)); }
    let rngW = paintedRanges(dirW);
    let rng = 1.0 - exp(-rngW * 2.4);
    var cl = vec2f(0.0);
    if (F.accent.w > 0.0) { cl = cloudsAt(dirW) * min(1.0, F.accent.w * 2.0); }
    // clouds: their shaded undersides a soft grey wash, their lit tops paper
    var ink = max(max(wash * (1.0 - 0.7 * cl.x), rng * (1.0 - 0.8 * cl.x)), 0.32 * cl.y);
    if (F.water.w > 0.0) { ink = max(ink, 0.12 * F.water.w * cloudBandsAt(dirW)); }
    // a low sun's halo: the sky round it left paper
    ink *= 1.0 - F.accent.z * exp(-sunAng / 0.09);
    var col = mix(paper, F.ink.rgb, ink);
    var absP = vec3f(0.0);
    // the warm sky toward the sun (sunset, dawn)
    let hz = 1.0 - smoothstep(0.0, 0.35, dirW.y);
    let toSun = pow(max(dot(dirW, F.sun.xyz), 0.0), 6.0);
    if (!night) { absP += (P_ZHE * 0.3 * (0.3 + 0.7 * toSun) + P_TENG * 0.25 * toSun) * F.accent.y * hz * F.accent.x; }
    // the sun's glow: pale gold round it, whiter at its core
    let glowW = F.accent.z * exp(-sunAng / 0.075);
    if (!night && F.accent.z > 0.0) { absP += (P_TENG * 0.17 + P_ZHE * 0.17) * glowW * (1.0 - 0.8 * exp(-sunAng / 0.012)) + (P_ZHE * 0.05 + P_INK * 0.03) * (1.0 - clamp(glowW * 1.5, 0.0, 1.0)); }
    // a sky tint (blue by day, deeper toward the zenith; the clouds and the ranges keep the paper)
    if (F.skyTint.w > 0.0) { absP += F.skyTint.rgb * F.skyTint.w * (0.25 + 0.75 * up) * (1.0 - cl.x) * (1.0 - 0.6 * rngW); }
    col *= exp(-absP);
    if (night) { col = nightGrade(col); }
    // the sun (or the moon) itself: the brightest thing in the painting
    if (F.accent.z > 0.0 && !night) { col = mix(col, vec3f(1.0, 0.985, 0.94), F.accent.z * exp(-sunAng / 0.012) * 0.9); }
    if (night) { col = mix(col, vec3f(0.97, 0.96, 0.9), 1.0 - smoothstep(0.016, 0.02, sunAng)); col += vec3f(0.1, 0.12, 0.16) * exp(-sunAng / 0.05); }
    return vec4f(col, 1.0);
  }

  let A = textureLoad(gA, p, 0);
  let Bv = textureLoad(gB, p, 0);
  let Cv = textureLoad(gC, p, 0);
  let cls = min(u32(A.w + 0.5), 31u);
  // debug views (?debug=): 1 class, 2 cast shadow and sun, 3 normals, 4 joints, 6 the water's wave lines (r)
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

  // ---- the water: its own pale wash; the sun's (or the moon's) path on it, one broken column below the sun's bearing,
  // its dashes fixed to the world (along and across that bearing), nearly whole under the sun by the far shore
  var sunPath = 0.0;
  if (cls == C_WATER) {
    let wn = zoomNoise(P, footprint, 45.0, vec3f(1.3, 7.1, 2.9));
    let MC = F.moonCol;
    if (MC.x > 0.0) {
      let mz = normalize(F.sun.xz + vec2f(1e-6, 0.0));
      let dz = normalize(dirW.xz + vec2f(1e-6, 0.0));
      let dAz = abs(atan2(mz.x * dz.y - mz.y * dz.x, dot(mz, dz)));
      let below = max(-dirW.y, 0.0);
      let ax = vec3f(mz.x, 0.0, mz.y);
      let ar = vec3f(-mz.y, 0.0, mz.x);
      let wob = zoomNoise(vec3f(dot(P, ax) * 1.7, 0.0, 3.0), footprint, 6.0, vec3f(0.0)) - 0.5;
      let core = 1.0 - smoothstep(0.0, 1.0, dAz / (MC.y + MC.z * below) + 0.5 * wob);
      let rows = zoomNoise(vec3f(dot(P, ar) * 0.3, 0.0, dot(P, ax) * 3.2) + vec3f(9.0), footprint, 5.0, vec3f(0.0));
      if (F.accent.z > 0.0) {
        let nearSun = 1.0 - smoothstep(0.0, 0.05, below);
        sunPath = core * mix(smoothstep(0.5 - 0.15 * core, 0.6 - 0.12 * core, rows), 1.0, 0.25 + 0.6 * nearSun * core) * MC.x;
      } else {
        sunPath = core * smoothstep(0.56 - 0.2 * core, 0.64 - 0.16 * core, rows) * MC.x;
      }
    }
    ink = F.water.x * (0.75 + 0.5 * wn);
    // ripple lines (the look's `waves`), 水纹 rows where it asks for them (waveMode 1); not lost in the haze, only faded
    // by the look's far distance
    if (F.shotDir.z > 0.0) {
      let sinG = max(abs(dirW.y), 0.004);
      var wave = 0.0;
      if (F.shotDir.w > 0.5) { wave = waveRows(P, footprint, sinG, clamp(F.shotDir.z, 0.0, 1.0), 0.45, 9.0) * 0.8; }
      else { wave = ripples(P, footprint, clamp(F.shotDir.z, 0.0, 1.0), 0.0, sinG); }
      wave *= 1.0 - smoothstep(F.lines.y * 0.35, F.lines.y * 1.1, dist);
      ink += wave * 0.6 / max(exp(-dist / (F.look.x * max(s2.w, 1.0))), 0.05);
      if (u32(F.counts.w + 0.5) == 6u) { return vec4f(wave, F.shotDir.z, F.shotDir.w, 1.0); }
    }
    ink *= 1.0 - min(sunPath * (1.0 + 0.4 * F.accent.z), 1.0);
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
      ink = s0.x + s0.y * F.gains.x * (0.16 + 0.55 * shade + 0.2 * under + 0.3 * clumpB) * mix(0.35, 1.0, body) * t5;
      // the leaf marks gather on the clumps' shaded undersides
      let dens = clamp(0.12 + 0.3 * shade + 0.6 * clumpB, 0.0, 0.9) * mix(0.4, 1.0, body);
      if (willow) { leaf = willowStrands(lp, fpo * 16.0, fpo, dens * 0.55, tseed); }
      else { leaf = leafDots(lp, fpo * 5.5, fpo, dens, tseed, 1.5) * (0.55 + 0.45 * clumpB); }
    }
    leaf *= s2.x * F.gains.z * (0.7 + 0.6 * hs) * (1.0 - smoothstep(1000.0, 2000.0, Do));
  }

  // ---- 墨荷: every lotus leaf one wash of its own depth, a little deeper where it turns from the light; veins (勾筋)
  // radiating from the leaf's centre (its instance's origin), near leaves only
  var vein = 0.0;
  if (cls == 24u) {
    let ii = Cv.y;
    let O = vec3f(bitcast<f32>(inst[ii * 16u + 9u]), bitcast<f32>(inst[ii * 16u + 10u]), bitcast<f32>(inst[ii * 16u + 11u]));
    let hd = hash3(vec3i(i32(Cv.x & 0xffffu), 77, 1));
    ink = (s0.x + s0.y * shade + s0.w * smoothstep(0.4, 0.95, 1.0 - abs(nW.y))) * (0.7 + 0.6 * hd);
    let v = P.xz - O.xz;
    let r = length(v);
    let a = atan2(v.y, v.x) + hd * 6.28;
    let dA = abs(fract(a / 6.2831 * 13.0 + 0.5) - 0.5) / 13.0 * 6.2831;
    vein = (1.0 - smoothstep(footprint * 0.3, footprint * 1.1, r * sin(dA))) * smoothstep(footprint * 4.0, footprint * 10.0, r)
         * (1.0 - smoothstep(F.lines.x * 0.8, F.lines.x * 2.5, dist)) * 0.55 * smoothstep(0.3, 0.55, zoomNoise(P + vec3f(4.4), footprint, 25.0, vec3f(0.0))) * s2.x;
  }

  // a roof's wash: the look's roof gain
  if (cls == C_ROOF) { ink *= F.gains.y; }

  // ---- rock: graded grey washes laid in mottled patches, deeper in shade, cut by vertical fissures with the shade of
  // the stepped plane beside each, a value per 斧劈 plane; near rock only (far it is the land's wash)
  var rockLine = 0.0;
  if ((cls == C_ROCK || cls == 25u) && F.veil.w > 0.0) {
    let nearR = 1.0 - smoothstep(F.lines.w * 0.3, F.lines.w * 0.8, dist);
    if (nearR > 0.0) {
      let fc2 = facets(P, nW, footprint, 150.0);
      let fis = fissures(P, nW, footprint);
      let mot = zoomNoise(P * vec3f(1.0, 0.45, 1.0) + vec3f(17.0), footprint, 70.0, vec3f(0.0));
      let mot2 = zoomNoise(P * vec3f(1.0, 0.3, 1.0) + vec3f(3.0), footprint, 22.0, vec3f(0.0));
      let pv = smoothstep(0.15, 0.85, smoothstep(0.05, 0.65, Bv.x));
      var rw = 0.17 + 0.24 * (1.0 - pv) + 0.2 * (mot - 0.5) + 0.08 * (mot2 - 0.5) + 0.07 + 0.3 * fis.y + 0.1 * fc2.x;
      if (cls == 25u) { rw = 0.3 + 0.12 * (1.0 - pv) + 0.1 * (mot - 0.5); }
      ink = mix(ink, rw, nearR);
      rockLine = max(max(fc2.y * 0.3, fis.x), rockStreaks(P, nW, footprint, 0.35 + 0.35 * shade) * 0.32)
               * nearR * (0.6 + 0.4 * shade) * select(1.0, 0.35, cls == 25u) * F.veil.w;
    }
  }
  // the carving (a figure in the rock): pale stone modelled where its form turns away from the eye (the angle the eye
  // sees it at, not the view's own axes)
  if (cls == 12u) {
    let rimV = pow(1.0 - clamp(abs(dot(nW, dirW)), 0.0, 1.0), 1.5);
    ink = 0.015 + 0.2 * rimV + 0.06 * (1.0 - smoothstep(0.1, 0.9, Bv.x));
  }

  // ---- the wash laid in a few layers (墨分五色): each step soft, a darker rim where a layer ends (水渍), the steps'
  // edges wandering with a world noise of ~45 px. Crowns and buildings keep most of their smooth wash
  let LAY = F.layering.x;
  if (LAY > 0.0 && cls != C_WATER && cls != 24u) {
    let wn = zoomNoise(P, footprint, 45.0, vec3f(5.1, 2.2, 9.7));
    let q = ink * LAY + (wn - 0.5) * 0.6;
    let fl = floor(q);
    let fr = q - fl;
    let layered = (fl + smoothstep(0.38, 0.62, fr)) / LAY;
    let rim = smoothstep(0.45, 0.6, fr) * (1.0 - smoothstep(0.6, 0.95, fr)) * step(0.0, fl) * step(0.02, ink);
    let k = select(select(0.5, 0.2, crown), 0.25, isArch(cls));
    ink = max(mix(ink, layered, k), 0.0) + rim * F.layering.y / LAY * select(select(1.0, 0.3, cls == C_ROCK), 0.0, crown);
  }
  ink += leaf * 0.95 + rockLine * 0.7 + vein;

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

  // ---- tile rows on a roof: lines running down each roof plane, a row every 0.3 m across the slope, the spacing
  // doubled as they get small (never closer than ~3 px: no moiré), broken along their length
  if (cls == 4u) {
    let tA0 = cross(nW, vec3f(0.0, 1.0, 0.0));
    if (dot(tA0, tA0) > 0.02) {
      let tA = normalize(tA0);
      let u = dot(P, tA);
      let px = max(footprint, 1e-4);
      let S = 0.3 * exp2(ceil(log2(max(3.2 * px / 0.3, 1.0))));
      let dl = abs(fract(u / S) - 0.5) * S / px;
      let along = dot(P, normalize(cross(tA, nW)));
      let brk = smoothstep(0.3, 0.55, vnoise2(vec2f(floor(u / S) * 3.7, along / max(px * 25.0, 0.2))));
      let tiles = (1.0 - smoothstep(0.35 - 0.2, 0.35 + 0.7, abs(dl - S / px * 0.5))) * brk * (0.55 + 0.45 * shade) * (1.0 - smoothstep(150.0, 450.0, dist));
      ink += tiles * 0.3;
    }
  }

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

  // ---- dark detail (細筆 inside the washes, after linan's painter): what is darker than the ring of its neighbours —
  // battens on a sail, timber framing on plaster, windows, tile rows, joints — drawn as fine ink. Built things and the
  // ground take the fine detail; trees, lotus and rock only clusters a few pixels across
  if (cls != C_WATER && cls != C_GLOW && cls != C_BLOOM && F.water.y < 0.5) {
    let fineK = isArch(cls) || cls == C_GROUND || cls == C_SMALL || cls == C_PAVE;
    let rr = select(4.0, 2.5, fineK) * F.viewport.x / 1664.0;
    let c0 = litAlbedo(p);
    var sm = 0.0; var sn = 0.0;
    for (var k = 0; k < 6; k++) {
      let a = f32(k) * 1.0472 + 0.3;
      let vv = litAlbedo(p + vec2i(round(vec2f(cos(a), sin(a)) * rr)));
      if (vv >= 0.0) { sm += vv; sn += 1.0; }
    }
    if (sn > 0.0 && c0 >= 0.0) {
      let hp = (sm / sn - c0) / (sm / sn + 0.04) * 0.25;
      var kk = 0.4;
      if (cls == C_PAVE) { kk = 0.35; } else if (cls == C_ROOF || cls == 19u) { kk = 0.15; } else if (isArch(cls)) { kk = 1.0; }
      else if (crown) { kk = 0.12; } else if (cls == 24u) { kk = 0.7; } else if (cls == C_ROCK || cls == 25u) { kk = 0.12 * F.veil.w; }
      else if (cls == 12u) { kk = 0.2; } else if (cls == C_GROUND) { kk = 1.1; }
      let lo = select(select(0.015, 0.005, fineK), select(0.06, 0.03, cls == C_GROUND), cls == C_GROUND || cls == C_PAVE);
      var det = 1.25 * clamp((hp - lo) / select(0.2, 0.16, fineK), 0.0, 0.8) * kk * F.gains.w;
      det *= 1.0 - smoothstep(F.lines.y * 0.3, F.lines.y, dist);
      ink += det;
    }
  }

  // ---- joints drawn on the surface (stone courses, voussoirs, slabs), and each block its own tone
  let joint = bitcast<f32>(Cv.z);
  let block = bitcast<f32>(Cv.w);
  if (block >= 0.0) { ink += 0.07 * (block - 0.5); }
  ink = max(ink, joint * select(0.6, 0.42, cls == C_PAVE) * F.ink.w * F.gains.w);

  // ---- snow: what faces up keeps the paper (the ground, rock, roofs, the tops of the crowns), its edge ragged
  if (F.lines.z > 0.0 && cls != C_WATER && cls != C_GLOW) {
    let sn = zoomNoise(P, footprint, 30.0, vec3f(4.1, 0.3, 8.8));
    let cover = smoothstep(0.42, 0.72, nW.y + (sn - 0.5) * 0.35) * F.lines.z;
    ink *= 1.0 - 0.85 * cover;
  }

  // ---- the far land: hills carry a wash of their own (steeper is darker), graded into the haze below
  var hazeScale = s2.w;
  var lineK = 1.0;
  if (cls == C_GROUND) {
    let far = smoothstep(350.0, 2200.0, dist);
    ink = mix(ink, 0.24 + 0.45 * (1.0 - clamp(nW.y, 0.0, 1.0)) + 0.15 * shade, far);
    // the far woods on the hills (above the plain and the shore), sparser up the bare ridges and under snow
    let wk = smoothstep(250.0, 700.0, dist) * smoothstep(6.0, 25.0, P.y) * (1.0 - 0.8 * F.lines.z);
    if (wk > 0.0) { ink = max(ink, farWoods(P, nW, footprint, 0.55 + 0.3 * shade) * 0.55 * wk); }
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
  // (lines full near, a third of their ink from half the look's far distance on: 淡墨 for the middle ground)
  edge *= mix(1.0, 0.3, smoothstep(F.lines.x * 1.5, F.lines.y * 0.5, dist)) * lineK;
  ink = max(ink, edge * F.ink.w);

  // ---- 留白: mist lying low in bands at distances from the look's viewpoint, and below a height, its edges ragged with
  // a world noise (both fixed to the world: walking through them, they stay where they lie)
  if (cls != C_WATER) {
    var mist = 0.0;
    let bn = zoomNoise(P * vec3f(1.0, 3.0, 1.0) + vec3f(23.0), footprint, 90.0, vec3f(0.0));
    let dS = length(P.xz - F.shotPos.xz);
    for (var k = 0; k < 3; k++) {
      let b = F.bands[k];
      if (b.z <= 0.0) { continue; }
      let along = 1.0 - smoothstep(b.y * 0.35, b.y, abs(dS - b.x) + (bn - 0.5) * b.y * 0.7);
      let low = 1.0 - smoothstep(b.w * 0.45, b.w, P.y - F.shotPos.w + (bn - 0.5) * b.w * 0.8);
      mist = max(mist, along * low * b.z * select(1.0, 0.45, isArch(cls)));
    }
    // the woods paling upward into the haze (a world height, so it holds still)
    if (F.veil.z > 0.0 && (crown || cls == C_GROUND || cls == C_ROCK)) {
      let vn = zoomNoise(P * vec3f(1.0, 2.0, 1.0) + vec3f(61.0), footprint, 60.0, vec3f(0.0));
      mist = max(mist, F.veil.z * smoothstep(F.veil.x, F.veil.y, P.y + (vn - 0.5) * (F.veil.y - F.veil.x) * 0.8) * (1.0 - smoothstep(700.0, 1200.0, dist)));
    }
    let M = F.mist;
    if (M.w > 0.0) {
      let mn = zoomNoise(P * vec3f(1.0, 4.0, 1.0) + vec3f(11.0), footprint, 120.0, vec3f(0.0));
      mist = max(mist, (1.0 - smoothstep(M.x, M.y, P.y + (mn - 0.5) * (M.y - M.x) * 1.2)) * smoothstep(M.z, M.z * 1.6, dist) * M.w);
    }
    ink *= 1.0 - clamp(mist, 0.0, 1.0);
  }

  // ---- into the haze: ink fades with distance (the class can carry further: far hills)
  let haze = exp(-dist / (F.look.x * hazeScale));
  ink = clamp(ink * haze, 0.0, 1.0);

  // ---- colour: the class's tint (blossom pink) under the ink of its marks and lines
  let tintK = s3.w * (1.0 - edge) * (1.0 - 0.6 * leaf);
  let inkCol = mix(F.ink.rgb, s3.rgb, tintK);
  var col = mix(paper, inkCol, ink);
  // colour accents of 纯水墨 (the look's `accent`): red maple, gold ginkgo, pink lotus flowers, vines; the sun's glow on
  // the forms before it and gold on its path on the water
  var absP = vec3f(0.0);
  let lit = clamp(Bv.x, 0.0, 1.0);
  if (cls == C_MAPLE) { absP += (P_ZHU * (1.0 + 0.4 * lit) + P_ZHE * 0.3) * F.accent.x; }
  else if (cls == C_GINKGO) { absP += (P_TENG * 0.9 + P_ZHE * 0.35) * F.accent.x; }
  else if (cls == C_IVY) { absP += (P_TENG * 0.6 + P_ZHE * 0.5) * 0.45 * F.accent.x; }
  else if (cls == C_BLOOM) { absP += P_ZHU * 0.2 * F.accent.x; }
  if (F.accent.z > 0.0 && F.water.y < 0.5) {
    let sunAng = acos(clamp(dot(dirW, F.sun.xyz), -1.0, 1.0));
    if (cls == C_WATER) { absP += (P_TENG * 0.1 + P_ZHE * 0.05) * sunPath * F.accent.z; }
    else { absP += (P_TENG * 0.1 + P_ZHE * 0.05) * F.accent.z * exp(-sunAng / 0.035); }
  }
  col *= exp(-absP * (1.0 - edge * 0.5));
  // at night: graded into the night's indigo; the moon's path on the water and the lamps keep their light
  if (F.water.y > 0.5) {
    col = nightGrade(col);
    if (cls == C_WATER) { col = mix(col, vec3f(0.85, 0.88, 0.92), clamp(sunPath, 0.0, 1.0)); }
    if (cls == C_GLOW) { col = vec3f(1.0, 0.86, 0.55); }
  }
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
