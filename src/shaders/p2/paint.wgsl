// Painter 2, pass 5: the painting (linan's PAINT_FRAG, the 纯水墨 style of the approved stills): 染 washes from the
// blurred tone with wet edges and granulation, 皴 strokes, leaf marks by species, 米点, ripple lines, the brush lines
// (pressure taper, 飞白, wobble, 洇), mist, colour. Every mark is placed from world positions (lattices in world space,
// per-tree frames, LOD-blended noise), the lattices' axes fixed per look; the paper lies on a sphere round the eye.
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> K: Ink2;
@group(0) @binding(2) var gA: texture_2d<f32>;
@group(0) @binding(3) var gB: texture_2d<f32>;
@group(0) @binding(4) var gC: texture_2d<u32>;
@group(0) @binding(5) var tBlur: texture_2d<f32>;
@group(0) @binding(6) var tBroad: texture_2d<f32>;
@group(0) @binding(7) var tEdge: texture_2d<f32>;
@group(0) @binding(8) var tJfa: texture_2d<u32>;
@group(0) @binding(9) var tRidge: texture_2d<f32>;
@group(0) @binding(10) var tLight: texture_2d<f32>;
@group(0) @binding(11) var tLightB: texture_2d<f32>;
@group(0) @binding(12) var samp: sampler;
@group(0) @binding(13) var<storage, read> inst: array<u32>;

const P_INK = vec3f(0.92, 0.98, 1.06); const P_ZHE = vec3f(0.18, 0.42, 0.85); const P_HUA = vec3f(0.95, 0.55, 0.28);
const P_TENG = vec3f(0.03, 0.12, 0.95); const P_ZHU = vec3f(0.06, 0.85, 0.80);

struct VOut { @builtin(position) pos: vec4f };
@vertex
fn vs(@builtin(vertex_index) k: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(vec2f(f32((k << 1u) & 2u), f32(k & 2u)) * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn texA(p: vec2i) -> vec4f { return textureLoad(gA, clamp(p, vec2i(0), vec2i(K.res.xy) - 1), 0); }
fn texB(p: vec2i) -> vec4f { return textureLoad(gB, clamp(p, vec2i(0), vec2i(K.res.xy) - 1), 0); }
fn smp(t: texture_2d<f32>, uv: vec2f) -> vec4f { return textureSampleLevel(t, samp, uv, 0.0); }

// ---- the paper (on a sphere round the eye, drifting slowly with forward travel, as Mo's): its colour and grain
fn paperOf(dirW: vec3f, uv: vec2f) -> vec4f {
  let q = dirW + F.eye.xyz / max(F.look.w, 1.0) * 0.002;
  let g = vnoise(q * 230.0) * 0.4 + vnoise(q * 90.0 + vec3f(7.0)) * 0.6;
  let fibre = vnoise(q * vec3f(60.0, 900.0, 60.0)) - 0.5;
  let stain = fbm3(q * 6.0 + vec3f(3.1, 7.7, 1.3), 3);
  var col = K.paperCol.rgb;
  // ageing: broad stains, darker toward the edges of the sheet
  let edge = smoothstep(0.45, 0.85, length((uv - 0.5) * vec2f(1.0, 0.82)));
  let age = K.paperCol.w * (0.35 * stain + 0.65 * edge);
  col *= mix(vec3f(1.0), vec3f(0.90, 0.82, 0.66), age);
  col *= 1.0 + F.paper.w * (0.35 * fibre + (g - 0.5) * 0.4);
  let grain = clamp(0.5 + 0.6 * (g - 0.5) + 0.25 * fibre, 0.0, 1.0);
  return vec4f(col, grain);
}

// ---- 皴: hemp-fibre (披麻) or axe-cut (斧劈) strokes on a world lattice, oriented down the slope
fn cunLevel(q: vec2f, dsl: vec2f, S: f32, pxu: f32, dens: f32, kind: f32, lev: f32) -> f32 {
  var cov = 0.0;
  let gi = floor(q / S);
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      let h = h43(vec3i(vec2i(gi + vec2f(f32(i), f32(j))), i32(lev) * 31 + 7));
      let on = markOn(h.x, dens);
      if (on <= 0.0) { continue; }
      let c = (gi + vec2f(f32(i), f32(j)) + h.yz) * S;
      let ink = (0.55 + 0.45 * h.w) * on;
      if (kind < 0.5) {
        let d = rot2(dsl, (h.w - 0.5) * 0.45);
        let L = S * (0.9 + 0.7 * h.y);
        let nrm = vec2f(-d.y, d.x);
        let a = c - d * L * 0.5; let m = c + nrm * L * 0.07 * (h.z - 0.5) * 2.0; let b = c + d * L * 0.5;
        let w = pxu * (0.55 + 0.5 * h.z);
        cov = max(cov, max(segCov(q, a, m, w * 0.25, w, pxu * 0.7), segCov(q, m, b, w, w * 0.15, pxu * 0.7)) * ink);
      } else {
        // 斧劈: short broad wedges cut diagonally, heavy at the head, dry at the tail
        let d = rot2(dsl, select(-0.55, 0.55, h.w > 0.5) + (h.y - 0.5) * 0.4);
        let L = S * (0.55 + 0.45 * h.y);
        let a = c - d * L * 0.5; let b = c + d * L * 0.5;
        let w = pxu * (0.9 + 1.1 * h.z);
        var cv = segCov(q, a, b, w, w * 0.1, pxu * 0.7);
        let v = q - a; let t = clamp(dot(v, d) / L, 0.0, 1.0); let acr = dot(v, vec2f(-d.y, d.x)) / max(w, 1e-4);
        let br = vnoise2(vec2f(acr * 3.5 + h.x * 40.0, t * 2.0));
        cv *= 1.0 - smoothstep(0.35, 0.95, t) * smoothstep(0.42, 0.6, br);
        cov = max(cov, cv * ink * (1.0 - 0.45 * t));
      }
    }
  }
  return cov;
}
/** the stills' fine horizontal hatching of the ground (linan hatchRows): rows 2.2 sheet px apart in a lattice q of
 *  sheet px, broken into lengths; k 0 leaves only their broken lengths as a flat tone */
fn hatchRows(q: vec2f, k: f32) -> f32 {
  let r = q.y / 2.2; let ri = floor(r); let f = r - ri;
  let a = vnoise2(vec2f(q.x / 55.0 + ri * 0.37, ri * 0.73)) * 0.7 + vnoise2(vec2f(q.x / 17.0, ri * 1.31 + 9.0)) * 0.3;
  return mix(0.68, 1.0 - smoothstep(0.18, 0.5, abs(f - 0.5)), k) * smoothstep(0.3, 0.75, a);
}
// dry side-brush texture: world-anchored noise stretched along the stroke, thresholded by density, gathered in groups
fn streakLevel(q: vec2f, d: vec2f, S: f32, dens: f32, kind: f32, lev: f32) -> f32 {
  let dp = vec2f(-d.y, d.x);
  let ratio = select(5.5, 7.0, kind < 0.5);
  let u = vec2f(dot(q, d) / S, dot(q, dp) / (S / ratio));
  let n = vnoise2(u + lev * 17.0) * 0.62 + vnoise2(u * vec2f(2.1, 1.7) + 5.3 + lev * 17.0) * 0.38;
  let cl = vnoise2(q / (S * 2.6) + lev * 3.1);
  let t = 1.0 - dens * (0.45 + 0.8 * cl);
  var c = smoothstep(t, t + 0.06, n);
  if (kind < 0.5) { c *= 0.55 + 0.45 * smoothstep(0.3, 0.6, vnoise2(u * vec2f(0.6, 4.0) + 9.0 + lev)); }
  else { c *= 0.7 + 0.3 * smoothstep(0.2, 0.7, vnoise2(u * vec2f(0.5, 1.5) + 9.0 + lev)); }
  return c;
}
fn cunStrokes(P: vec3f, Nw: vec3f, fp: f32, dens: f32, kind: f32) -> f32 {
  let uK = K.res.z;
  // the vertical plane facing the look; strokes run down the slope as the painter sees it
  let q = vec2f(dot(P, K.axisR.xyz), P.y);
  let dS = vec3f(0.0, -1.0, 0.0) + Nw * Nw.y;
  let d2 = vec2f(dot(dS, K.axisR.xyz), dS.y);
  let dsl = select(vec2f(0.0, -1.0), normalize(d2), dot(d2, d2) > 1e-4);
  let cellPx = select(70.0, 30.0, kind < 0.5);
  let l = log2(fp * cellPx * uK); let l0 = floor(l); let t = smoothstep(0.0, 1.0, l - l0);
  let side = select(-1.0, 1.0, dot(Nw, K.axisR.xyz) >= 0.0);
  let dst = normalize(vec2f(select(0.42, 0.12, kind < 0.5) * side, -1.0));
  let a = max(streakLevel(q, dst, exp2(l0), dens, kind, l0), 0.8 * cunLevel(q, dsl, exp2(l0), fp * uK, dens * 0.35, kind, l0));
  let b = max(streakLevel(q, dst, exp2(l0 + 1.0), dens, kind, l0 + 1.0), 0.8 * cunLevel(q, dsl, exp2(l0 + 1.0), fp * uK, dens * 0.35, kind, l0 + 1.0));
  return mix(a, b, t);
}

// ---- leaf marks in a per-tree frame (u across the line of sight to the trunk, v up, metres, centred on the tree)
fn pineFans(p: vec2f, S: f32, pxu: f32, dens: f32, seed: f32) -> f32 {
  var cov = 0.0;
  let gi = floor(p / S);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let h = h43(vec3i(vec2i(gi + vec2f(f32(i), f32(j))), i32(seed)));
      let on = markOn(h.x, dens);
      if (on <= 0.0) { continue; }
      let c = (gi + vec2f(f32(i), f32(j)) + 0.15 + 0.7 * h.yz) * S;
      let v = p - c; let r = length(v);
      let L = S * (0.62 + 0.3 * h.w);
      if (r > L) { continue; }
      // half wheel of needles opening upward (松針), slightly tilted
      let th0 = 1.5708 + (h.w - 0.5) * 0.9;
      let phi = fmodp(atan2(v.y, v.x) - th0 + 3.14159, 6.28318) - 3.14159;
      let span = 1.25;
      if (abs(phi) > span + 0.1) { continue; }
      let stepA = span * 2.0 / 8.0;
      let kk = clamp(floor((phi + span) / stepA + 0.5), 0.0, 8.0);
      let dA = phi - (kk * stepA - span);
      let dist = r * abs(sin(dA));
      let w = pxu * 0.45;
      let cv = smoothstep(w + pxu * 0.6, w - pxu * 0.2, dist) * smoothstep(L, L * 0.75, r) * smoothstep(0.0, L * 0.12, r);
      cov = max(cov, cv * (0.65 + 0.35 * h.w) * on);
      cov = max(cov, smoothstep(pxu * 1.6, pxu * 0.8, r) * 0.9 * on);
    }
  }
  return cov;
}
fn willowStrands(p: vec2f, S: f32, pxu: f32, dens: f32, seed: f32) -> f32 {
  var cov = 0.0;
  let gi = floor(p / vec2f(S * 0.5, S));
  for (var j = 0; j <= 3; j++) {
    for (var i = -1; i <= 1; i++) {
      let h = h43(vec3i(vec2i(gi + vec2f(f32(i), f32(j))), i32(seed) + 3));
      let on = markOn(h.x, dens);
      if (on <= 0.0) { continue; }
      let top = (gi + vec2f(f32(i), f32(j)) + vec2f(h.y, 0.5 + 0.5 * h.z)) * vec2f(S * 0.5, S);
      let L = S * (3.5 + 3.0 * h.w);
      let t = (top.y - p.y) / L;
      if (t < 0.0 || t > 1.0) { continue; }
      let x = top.x + sin(t * 2.2 + h.w * 6.0) * S * 0.12 + t * t * S * 0.25 * (h.z - 0.5);
      let w = pxu * 0.38 * (1.0 - 0.7 * t);
      var cv = smoothstep(w + pxu * 0.6, w - pxu * 0.2, abs(p.x - x));
      cv *= smoothstep(0.3, 0.5, vnoise2(vec2f(h.y * 50.0, t * 5.0)));
      cov = max(cov, cv * (0.55 + 0.45 * h.w) * (1.0 - 0.75 * t) * on);
    }
  }
  return cov;
}
/** 点叶 dots (ring = 1 draws 夹叶 outlines instead) */
fn leafDots(p: vec2f, S: f32, pxu: f32, dens0: f32, seed: f32, ring: f32, elong: f32) -> f32 {
  var cov = 0.0;
  let dens = dens0 * smoothstep(0.25, 0.6, vnoise2(p / (S * 3.2) + seed * 0.37));
  let gi = floor(p / S);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      for (var k = 0; k < 2; k++) {
        let h = h43(vec3i(vec2i(gi + vec2f(f32(i), f32(j))), i32(seed) * 2 + k + 11));
        let on = markOn(h.x, dens);
        if (on <= 0.0) { continue; }
        let c = (gi + vec2f(f32(i), f32(j)) + h.yz) * S;
        let r = S * (0.22 + 0.16 * h.w);
        let a = (h.w - 0.5) * 1.6 + select(-0.5, 0.3, k == 0);
        var v = rot2(p - c, a); v.x /= elong;
        let d = length(v) / r;
        let aa = pxu / r;
        var cv = 0.0;
        if (ring > 0.5) { cv = smoothstep(0.16 + aa, 0.16 - aa, abs(d - 0.85)) * 0.9; }
        else { cv = smoothstep(1.0 + aa, 1.0 - aa, d) * (0.72 + 0.28 * smoothstep(0.5, 1.0, d)); }
        cov = max(cov, cv * (0.55 + 0.45 * h.x / max(dens, 1e-3)) * on);
      }
    }
  }
  return cov;
}
/** maple / ginkgo: solid lobed marks, clumped, two per cell */
fn lobedLeaves(p: vec2f, S: f32, pxu: f32, dens0: f32, seed: f32, lobes: f32) -> f32 {
  var cov = 0.0;
  let dens = dens0 * smoothstep(0.2, 0.55, vnoise2(p / (S * 3.0) + seed * 0.41));
  let gi = floor(p / S);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      for (var k = 0; k < 2; k++) {
        let h = h43(vec3i(vec2i(gi + vec2f(f32(i), f32(j))), i32(seed) * 2 + k + 61));
        let on = markOn(h.x, dens);
        if (on <= 0.0) { continue; }
        let c = (gi + vec2f(f32(i), f32(j)) + h.yz) * S;
        let r = S * (0.26 + 0.16 * h.w);
        let v = rot2(p - c, h.w * 6.28);
        let a = atan2(v.y, v.x);
        let rr = r * (0.55 + 0.45 * pow(abs(cos(a * lobes * 0.5)), 0.7));
        let aa = pxu * 0.8;
        cov = max(cov, smoothstep(rr + aa, rr - aa, length(v)) * (0.6 + 0.4 * h.x / max(dens, 1e-3)) * on);
      }
    }
  }
  return cov;
}
/** 米点: soft horizontal blobs (far woods) */
fn miDots(p: vec2f, S: f32, dens: f32, seed: f32) -> f32 {
  var cov = 0.0;
  let cs = vec2f(S * 1.3, S * 0.7);
  let gi = floor(p / cs);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let h = h43(vec3i(vec2i(gi + vec2f(f32(i), f32(j))), i32(seed) + 23));
      let on = markOn(h.x, dens);
      if (on <= 0.0) { continue; }
      let c = (gi + vec2f(f32(i), f32(j)) + h.yz) * cs;
      let v = (p - c) / (S * vec2f(0.62, 0.3) * (0.8 + 0.4 * h.w));
      cov += smoothstep(1.0, 0.45, length(v)) * (0.35 + 0.4 * h.w) * on;
    }
  }
  return min(cov, 1.0);
}

// ---- a tree's boughs as the references draw them: a few dark limbs from the fork, thick at the trunk and tapering,
// painted in the tree's own frame (p: m across the line of sight and up from the trunk's foot; sc the tree's scale).
// x: coverage, y: m to the nearest limb (blossom gathers along them). Willow limbs arch out and droop; a peach's fan up.
fn boughs(p: vec2f, sc: f32, pxu: f32, seed: f32, willow: bool) -> vec2f {
  var cov = 0.0; var dmin = 1e9;
  let fork = vec2f(0.0, select(1.1, 2.6, willow) * sc);
  let n = select(6, 5, willow);
  for (var k = 0; k < n; k++) {
    let h = h43(vec3i(i32(seed), k, 913));
    let h2 = h43(vec3i(i32(seed), k, 917));
    let side = select(-1.0, 1.0, (f32(k) + h.x * 0.8) % 2.0 >= 1.0);
    // three bends: out of the fork, up and over, and (a willow's) down at the tip; each joint kinked a little
    let a = fork + vec2f(side * 0.15 * sc * h.y, -0.4 * sc * h.z);
    var m1 = vec2f(0.0); var m2 = vec2f(0.0); var b = vec2f(0.0);
    if (willow) {
      m1 = fork + vec2f(side * (0.35 + 0.6 * h.y), 0.9 + 1.0 * h.z) * sc;
      m2 = m1 + vec2f(side * (0.5 + 0.7 * h.w), 0.6 + 0.9 * h2.x - 0.2) * sc;
      b = m2 + vec2f(side * (0.4 + 0.6 * h2.y), -0.4 - 1.0 * h2.z) * sc;
    } else {
      m1 = fork + vec2f(side * (0.2 + 0.45 * h.y), 0.45 + 0.5 * h.z) * sc;
      m2 = m1 + vec2f(side * (0.25 + 0.5 * h.w) + (h2.x - 0.5) * 0.3, 0.35 + 0.5 * h2.y) * sc;
      b = m2 + vec2f(side * (0.2 + 0.5 * h2.z) - (h2.w - 0.5) * 0.4, 0.3 + 0.5 * h.x) * sc;
    }
    let w = max(pxu * 0.5, select(0.045, 0.06, willow) * sc);
    let w1 = max(pxu * 0.45, w * 0.6); let w2 = max(pxu * 0.4, w * 0.35); let wt = max(pxu * 0.35, 0.01 * sc);
    let c = max(max(segCov(p, a, m1, w, w1, pxu * 0.8), segCov(p, m1, m2, w1, w2, pxu * 0.8)), segCov(p, m2, b, w2, wt, pxu * 0.8));
    cov = max(cov, c * (0.75 + 0.25 * h.w));
    // (distance to the limb's outer part, where the twigs and blossom are)
    let pb = p - m1; let bb = b - m1;
    let hb = clamp(dot(pb, bb) / max(dot(bb, bb), 1e-6), 0.0, 1.0);
    dmin = min(dmin, length(pb - bb * hb));
  }
  return vec2f(cov, dmin);
}
/** willow strands as the references paint them: long thin threads hanging straight down, each a run of small leaf
 *  dashes with gaps, a gentle sway; spaced in the world (0.2 m × scale) and thinned to a wash as they get finer than
 *  a few pixels */
fn willowThreads(p: vec2f, sc: f32, pxu: f32, dens: f32, seed: f32) -> f32 {
  let S0 = 0.2 * sc;
  let l = log2(max(3.5 * pxu / S0, 1.0)); let l0 = floor(l); let lt = l - l0;
  var out = 0.0;
  for (var L = 0; L < 2; L++) {
    let wl = select(1.0 - lt, lt, L == 1);
    if (wl < 0.01) { continue; }
    let S = S0 * exp2(l0 + f32(L));
    let gi = floor(p.x / S);
    var cov = 0.0;
    for (var i = -1; i <= 1; i++) {
      let col = gi + f32(i);
      let h = h43(vec3i(i32(col), i32(seed), 37 + L));
      let x0 = (col + 0.2 + 0.6 * h.y) * S;
      let sway = 0.06 * sc * sin(p.y / (1.1 * sc) + h.w * 6.28);
      let w = max(pxu * 0.35, 0.012 * sc);
      let dx = abs(p.x - x0 - sway);
      if (dx > w + pxu) { continue; }
      // runs of 1–2.5 m with gaps, each run a chain of leaf dashes
      let seg = floor(p.y / (1.6 * sc) + h.z);
      let hs = h43(vec3i(i32(col), i32(seg), i32(seed) + 71));
      let on = markOn(hs.x, dens);
      let dash = smoothstep(0.15, 0.3, fract(p.y / max(0.11 * sc, pxu * 3.0) + h.x * 7.0)) * smoothstep(0.95, 0.8, fract(p.y / max(0.11 * sc, pxu * 3.0) + h.x * 7.0));
      let cv = smoothstep(w + pxu * 0.7, w - pxu * 0.2, dx) * mix(1.0, dash, 0.7) * on;
      cov = max(cov, cv * (0.55 + 0.45 * hs.w));
    }
    out += wl * cov;
  }
  return out;
}

// ---- ripple lines on the water plane (world XZ in the look's frame, rows spread so they keep a screen spacing)
fn ripples(P: vec3f, fp: f32, dens: f32, sinG: f32, sinW: f32) -> f32 {
  let uK = K.res.z;
  let r2 = normalize(K.axisR.xz); let f2 = normalize(K.axisF.xz);
  let l = log2(fp * 46.0 * uK); let l0 = floor(l); let t = smoothstep(0.0, 1.0, l - l0);
  let q = vec2f(dot(P.xz, r2), dot(P.xz, f2));
  let pxu = fp * uK;
  var cov = 0.0;
  for (var L = 0; L < 2; L++) {
    let lev = l0 + f32(L);
    let S = exp2(lev);
    let Sv = S / max(sinW, 0.02) * 0.35;
    let gi = floor(q / vec2f(S, Sv));
    var c0 = 0.0;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let h = h43(vec3i(vec2i(gi + vec2f(f32(i), f32(j))), i32(lev) * 5 + 3));
        let on = markOn(h.x, dens);
        if (on <= 0.0) { continue; }
        let c = (gi + vec2f(f32(i), f32(j)) + vec2f(h.y, 0.5)) * vec2f(S, Sv);
        let v = q - c;
        let L2 = S * (0.35 + 0.4 * h.z);
        let u = v.x / L2;
        if (abs(u) > 1.0) { continue; }
        let bow = (1.0 - u * u) * Sv * 0.12 * (h.w - 0.5);
        let w = pxu * 0.5 * (1.0 - u * u);
        let cv = smoothstep(w + pxu * 0.5, w - pxu * 0.3, abs(v.y - bow) * sinG / max(sinG, 0.02));
        c0 = max(c0, cv * (0.5 + 0.5 * h.w) * on);
      }
    }
    cov += c0 * select(t, 1.0 - t, L == 0);
  }
  return cov;
}
// ---- 水纹: rows of drawn wave lines over the whole water, rows kept ~rowPx apart
fn waveRows(P: vec3f, fp: f32, sinG: f32, sinW: f32, dens: f32, amp: f32, rowPx: f32) -> f32 {
  let uK = K.res.z;
  let r2 = normalize(K.axisR.xz); let f2 = normalize(K.axisF.xz);
  let q = vec2f(dot(P.xz, r2), dot(P.xz, f2));
  let pxPerV = sinG / max(fp, 1e-5);
  let l = log2(rowPx * uK / pxPerV); let l0 = floor(l); let t = smoothstep(0.0, 1.0, l - l0);
  var cov = 0.0;
  for (var L = 0; L < 2; L++) {
    let lev = l0 + f32(L);
    let Sv = exp2(lev);
    let Su = Sv * 4.5 * max(sinW, 0.03);
    let ph = vnoise2(vec2f(q.x / (Su * 5.0), q.y / (Sv * 4.0)) + lev) * 2.0;
    let g = q.y / Sv + amp * abs(sin(3.14159 * (q.x / Su + ph)));
    let k = floor(g + 0.5);
    let dpx = abs(g - k) * Sv * pxPerV;
    let w = 0.45 * uK;
    var c = smoothstep(w + 0.6 * uK, w - 0.3 * uK, dpx);
    c *= smoothstep(1.0 - dens, 1.0 - dens + 0.15, vnoise2(vec2f(q.x / (Su * 1.7), k * 1.37 + lev * 3.0)));
    cov += c * select(t, 1.0 - t, L == 0);
  }
  return cov;
}

// ---- 斧劈 / 卷云 facets: a Voronoi partition of the face plane; x = cell value, y = metres to the cell border
fn facetCell(q0: vec2f, S: f32, shear: f32, seed: f32) -> vec2f {
  var q = q0; q.x += shear * q.y;
  let g = q / vec2f(S, S * 1.6); let gi = floor(g); let gf = g - gi;
  var d1 = 9.0; var d2 = 9.0; var id = gi;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let o = vec2f(f32(i), f32(j));
      let h = h43(vec3i(vec2i(gi + o), i32(seed)));
      let v = (o + 0.1 + 0.8 * h.xy - gf) * vec2f(1.0, 1.6);
      let d = length(v);
      if (d < d1) { d2 = d1; d1 = d; id = gi + o; } else if (d < d2) { d2 = d; }
    }
  }
  return vec2f(h13(vec3i(vec2i(id), i32(seed) + 5)), (d2 - d1) * 0.5 * S);
}
fn facets(P: vec3f, Nw: vec3f, fp: f32, bigPx: f32) -> vec2f {
  let uK = K.res.z;
  let q = vec2f(dot(P, K.axisR.xyz), P.y);
  let side = select(-1.0, 1.0, dot(Nw, K.axisR.xyz) >= 0.0);
  let l = log2(fp * bigPx * uK); let l0 = floor(l); let t = smoothstep(0.0, 1.0, l - l0);
  var r = vec2f(0.0);
  for (var L = 0; L < 2; L++) {
    let S = exp2(l0 + f32(L));
    let a = facetCell(q, S, 0.35 * side, 401.0 + (l0 + f32(L)) * 3.0);
    let b = facetCell(q + 7.3, S * 0.36, -0.25 * side, 433.0 + (l0 + f32(L)) * 3.0);
    let px = fp * uK;
    let line = smoothstep(px * 1.3, px * 0.4, a.y) * step(0.62, a.x) * smoothstep(0.35, 0.6, vnoise2(q / (S * 0.7) + 3.0));
    let v = vec2f((a.x - 0.5) * 0.65 + (b.x - 0.5) * 0.35, line);
    r += v * select(t, 1.0 - t, L == 0);
  }
  return r;
}
// ---- the vertical fissures of a limestone face: x = the crack's ink, y = the shade of the step beside it
fn fissures(P: vec3f, fp: f32) -> vec2f {
  let q = vec2f(dot(P, K.axisR.xyz), P.y);
  let px = max(fp * K.res.z, 1e-4);
  let l = log2(px * 38.0); let l0 = floor(l); let t = smoothstep(0.0, 1.0, l - l0);
  var r = vec2f(0.0);
  for (var L = 0; L < 2; L++) {
    let lev = l0 + f32(L);
    let S = exp2(lev);
    let ci = floor(q.x / S);
    var on = 0.0; var side = 0.0;
    for (var i = -1; i <= 1; i++) {
      let c = ci + f32(i);
      let h = h43(vec3i(i32(c), i32(lev) + 64, 913));
      let x = (c + 0.2 + 0.6 * h.x) * S + S * 0.3 * (vnoise2(vec2f(c * 7.1, q.y / (S * 1.7))) - 0.5) + S * 0.07 * (vnoise2(vec2f(c * 3.3, q.y / (S * 0.35))) - 0.5);
      var seg = smoothstep(0.3, 0.5, vnoise2(vec2f(c * 5.7 + 2.0, q.y / (S * 3.0) + h.y * 9.0)));
      let d = (q.x - x) / px;
      seg *= step(0.3, h.z);
      let w = (0.25 + 0.9 * h.y * h.y) * seg;
      on = max(on, smoothstep(w + 0.8, w - 0.3, abs(d)) * seg * (0.55 + 0.45 * h.z));
      side = max(side, step(0.0, d) * exp(-d / (5.0 + 16.0 * h.w)) * seg);
    }
    r += vec2f(on, side) * select(t, 1.0 - t, L == 0);
  }
  return r;
}

// ---- painted far ranges (远山) in the sky: directions only, so they stay put as the camera moves
fn ridgeLine(d2: vec2f, k: f32) -> f32 {
  let c = d2 * (16.0 + 5.0 * k);
  let n = vnoise2(c + k * 11.3) * 0.55 + vnoise2(c * 2.3 + 3.1 + k * 5.0) * 0.3 + vnoise2(c * 5.3 + 9.7 + k) * 0.15;
  let big = vnoise2(d2 * (4.0 + k) + 40.0 + k * 3.7);
  return n * 1.25 - 0.35 + (big - 0.5) * 1.1;
}
/** → (wash, ridge proximity (1 at the ridge), index of the range + 1 (0: none)) */
fn paintedRanges(dirW: vec3f) -> vec3f {
  let R = K.ranges; let RB = K.rangesB;
  if (R.w < 0.5) { return vec3f(0.0); }
  let match_ = K.look3.y > 0.0;
  let uK = K.res.z; let pxA = K.res.w;
  let el = asin(clamp(dirW.y, -1.0, 1.0));
  let d2 = normalize(dirW.xz + vec2f(1e-6, 0.0));
  let az = atan2(d2.x, d2.y);
  var win = 1.0;
  if (RB.y > 0.0) {
    let da = abs(fmodp(az - RB.x + 3.14159, 6.28318) - 3.14159);
    win = select(1.0 - smoothstep(RB.y * 0.6, RB.y, da), 1.0 - smoothstep(RB.y * 0.3, RB.y * 1.4, da), match_);
  }
  var res = vec3f(0.0);
  let n = i32(R.w);
  for (var k = 0; k < 6; k++) {
    if (k >= n) { break; }
    let fk = f32(k);
    let kk = f32(n - 1) - fk;
    let base = R.x + kk * R.y;
    let amp = R.z * (0.55 + 0.45 * kk / max(f32(n - 1), 1.0)) * win;
    var ridge = base + amp * ridgeLine(d2, fk) - (1.0 - win) * select(0.05, 0.16, match_);
    // (the references' far hills have woods on their crests: a ridge broken by small bumps a few pixels high, and
    // no hard edge)
    if (match_ && K.sh3.z < 0.5) { ridge += (vnoise2(vec2f(az / (pxA * uK * 6.0), fk * 13.0)) - 0.5) * pxA * uK * 5.0; }
    if (el < ridge + select(0.0, pxA * uK * 2.0, match_)) {
      let below = ridge - el;
      let fade = RB.w * select(0.7 + 0.5 * vnoise2(d2 * 14.0 + fk), 0.85 + 0.3 * vnoise2(d2 * 4.0 + fk), match_);
      let ink = RB.z * mix(0.28, 1.0, fk / max(f32(n - 1), 1.0));
      let tq = select(vec2f(az * 320.0, el * 700.0), vec2f(az * 60.0, el * 90.0), match_);
      var tex = smoothstep(0.35, 0.75, vnoise2(tq + fk * 7.0) * 0.6 + vnoise2(tq * vec2f(2.3, 1.9) + 3.0) * 0.4);
      if (match_) { tex = 0.5 + 0.5 * (tex - 0.5); }
      let crisp = select(0.3, 0.0, match_);
      var w = ink * (crisp * exp(-below / (fade * 0.12)) + (1.0 - crisp) * exp(-below / fade) * (0.6 + 0.6 * tex * exp(-below / (fade * 0.6))));
      if (match_ && K.sh3.z > 0.5) {
        // a snowy range: left as paper, drawn by its ridge line, a few crevices and the spurs' shade
        let qp = vec2f(az, el) / (pxA * uK);
        let line = smoothstep(1.8, 0.4, below / (pxA * uK)) * (0.55 + 0.45 * smoothstep(0.3, 0.6, vnoise2(qp / 30.0 + fk)));
        let g = smoothstep(0.4, 0.6, vnoise2(qp / 70.0 + fk * 5.0));
        let c1 = smoothstep(0.74, 0.86, vnoise2(vec2f((qp.x + 0.7 * qp.y) / 3.0, qp.y / 45.0) + fk * 13.0));
        let c2 = smoothstep(0.74, 0.86, vnoise2(vec2f((qp.x - 0.7 * qp.y) / 3.0, qp.y / 45.0) + fk * 17.0));
        let crev = mix(c1, c2, g) * smoothstep(0.3, 0.6, vnoise2(qp / 35.0 + 3.0 + fk));
        let sp0 = vnoise2(vec2f((qp.x + 0.8 * qp.y) / 38.0, qp.y / 200.0) + fk * 7.0);
        let spur = smoothstep(0.5, 0.62, sp0) * (0.6 + 0.4 * vnoise2(qp / 12.0));
        let dn = exp(-below / (fade * 0.9));
        let mot = vnoise2(d2 * 9.0 + fk * 4.1);
        // (the references' snowy peaks: grey on their shaded spurs and in the gullies, the snow left paper, the crest
        // only a broken breath of a line)
        w = select(ink * 0.22 * exp(-below / fade) * (0.4 + 0.9 * mot) * smoothstep(0.0, pxA * 3.0 * uK, below),
                   ink * (0.12 * line + 0.75 * crev * exp(-below / (fade * 0.45)) + 0.6 * spur * dn + 0.16 * dn * mot), kk < 0.5);
      } else if (match_) {
        let mot = vnoise2(d2 * (7.0 + 2.0 * fk) + fk * 4.1) * 0.65 + vnoise2(d2 * 23.0 + fk * 1.7) * 0.35;
        // the woods on it in fine dots, thickest under the crest; the crest itself feathered into the sky
        let qd = vec2f(az, el) / (pxA * uK * 3.5) + fk * 7.0;
        let dots = smoothstep(0.5, 0.78, vnoise2(qd) * 0.7 + vnoise2(qd * 2.1 + 3.0) * 0.3) * exp(-below / (fade * 0.5));
        w *= (0.35 + 0.95 * smoothstep(0.25, 0.75, mot)) * (1.0 + 0.45 * dots) * smoothstep(-pxA * 2.0 * uK, pxA * 4.0 * uK, below);
      }
      res = vec3f(w, exp(-below / fade), fk + 1.0);
    }
  }
  return res;
}

fn focusOf(Fo: vec4f, uv: vec2f) -> f32 {
  if (Fo.z <= 0.0) { return 0.0; }
  let d = (uv - Fo.xy) * vec2f(K.res.x / K.res.y, 1.0);
  return exp(-dot(d, d) / (Fo.z * Fo.z));
}
fn bandOf(Bd: vec4f, P: vec3f, n: f32) -> f32 {
  if (Bd.z <= 0.0) { return 0.0; }
  let dS = length(P.xz - K.anchor.xz);
  let along = 1.0 - smoothstep(Bd.y * 0.35, Bd.y, abs(dS - Bd.x) + (n - 0.5) * Bd.y * 0.7);
  let low = 1.0 - smoothstep(Bd.w * 0.45, Bd.w, P.y - K.anchor.w + (n - 0.5) * Bd.w * 0.8);
  return along * low * Bd.z;
}
/** clouds on a layer ~2 km up, seen from the eye (fixed to the world): (coverage, the shaded underside) */
/** albedo × light of a G-buffer texel (−1: no surface); and the albedo alone (slab joints without the cast shadows) */
// (the sky's B is cleared to zero and every surface has some albedo: one fetch tells them apart)
fn gShade(p: vec2i) -> f32 { let b = texB(p); if (b.z <= 0.0) { return -1.0; } return b.z * (0.6 * max(b.x, 0.0) + max(b.y, 0.0)); }
fn gAlb(p: vec2i) -> f32 { let b = texB(p); if (b.z <= 0.0) { return -1.0; } return b.z; }
fn originOf(ii: u32) -> vec3f { return vec3f(bitcast<f32>(inst[ii * 16u + 9u]), bitcast<f32>(inst[ii * 16u + 10u]), bitcast<f32>(inst[ii * 16u + 11u])); }
/** an instance's vertical scale (its matrix's Y column) */
fn scaleOf(ii: u32) -> f32 { return length(vec3f(bitcast<f32>(inst[ii * 16u + 3u]), bitcast<f32>(inst[ii * 16u + 4u]), bitcast<f32>(inst[ii * 16u + 5u]))); }

/** the brush line through the nearest seed of the jump flood (J): its strength, width, direction and type → the line's
 *  ink and its 洇 beside it */
fn brushLine(J: vec4u, fc: vec2f, idk: f32, fK: f32, grain: f32) -> vec2f {
  let uK = K.res.z; let pxA = K.res.w; let match_ = K.look3.y > 0.0;
  let near = K.sh0.x; let far = K.sh0.y; let ridgeFrom = K.sh1.y;
  let sp = vec2i(i32(J.x & 0xffffu), i32(J.x >> 16u));
  let E = textureLoad(tEdge, sp, 0);
  let SA = texA(sp);
  let sOut = vec2f(sp) + 0.5;
  let vl = fc - sOut;
  let Ps = relPosOf(sOut / K.res.xy, depthOf(SA)) + F.eye.xyz;
  let fps = depthOf(SA) * pxA * uK;
  let nrm = vec2f(cos(E.z), sin(E.z));
  let typ = E.w;
  let n1 = lodNoise(Ps, fps * 30.0);
  let n2 = lodNoise(Ps + 17.3, fps * 70.0);
  var pressure = select(smoothstep(0.2, 0.6, n1) * (0.55 + 0.75 * n1), 0.85 + 0.25 * n1, typ > 0.5 && typ < 1.5);
  if (typ > 1.5 && typ < 2.5) { pressure *= smoothstep(0.3, 0.55, lodNoise(Ps + 5.1, fps * 18.0)); }   // foliage / ground: broken
  // rock: long tapered strokes with gaps between them (the brush lifts), heavier toward the focus
  if (typ > 2.5 && typ < 3.5) { pressure *= smoothstep(0.32, 0.62, lodNoise(Ps + 8.3, fps * 55.0)) * (0.55 + 0.6 * lodNoise(Ps + 2.2, fps * 25.0)); }
  // the carving: an even, unbroken fine line (白描)
  if (typ > 3.5) { pressure = 0.75 + 0.35 * n1; }
  let fine = (typ > 0.5 && typ < 1.5) || typ > 3.5;
  let w = E.y * pressure * K.st1.z;
  let off = (n2 - 0.5) * 2.0 * K.st2.x * uK * select(1.0, 0.12, fine);
  let sd = select(-1.0, 1.0, dot(vl, nrm) >= 0.0);
  let d = max(length(vl) - off * sd, 0.0);
  var cov = smoothstep(w + 0.7 * uK, w - 0.5 * uK, d) * E.x;
  // 飞白: dry streaks along the stroke where the brush runs out
  let across = d * sd / max(w, 0.5);
  let br = vnoise3(vec3f(across * 2.6 + 31.0, 0.0, 0.0) + Ps / max(fps * 14.0, 1e-4));
  let dry = select(mix(K.st2.y, 1.0, pow(1.0 - clamp(pressure, 0.0, 1.0), 2.0)), K.st2.y * 0.3, fine);
  cov *= 1.0 - dry * smoothstep(0.4, 0.62, br);
  // brush lines on land and trees lighter than the 界画 of the buildings, fading out on the far masses
  let sc0 = clsOf(SA);
  let lk = select(1.0, 0.7 * (1.0 - 0.7 * smoothstep(ridgeFrom * 0.4, ridgeFrom, depthOf(SA))), match_ && !isArch(sc0) && sc0 != C_FIGURE);
  let lineInk = lk * cov * (0.75 + 0.35 * n2) * mix(1.0, select(0.5, 0.3, match_), smoothstep(near * 1.5, far * 0.5, depthOf(SA))) * select(mix(0.45, 1.0, idk), mix(0.75, 1.0, fK), fine);
  // 洇: the ink creeps a little into the fibres beside the line
  var bleed = 0.0;
  if (d > w) { bleed = lk * exp(-(d - w) / (1.3 * uK)) * 0.22 * E.x * pressure * (0.4 + grain); }
  return vec2f(lineInk, bleed);
}

// the painted bore's crests, exactly as linan's src/modules/tide.js builds them (hash1, inkCurl, inkHeight: keep in sync)
fn boreHash(n: i32) -> f32 {
  var x = (bitcast<u32>(n) * 2654435761u) ^ 0x5bd1e995u;
  x = (x ^ (x >> 15u)) * 2246822519u; x = (x ^ (x >> 13u)) * 3266489917u;
  return f32(x ^ (x >> 16u)) / 4294967296.0;
}
/** the curl of the crest at al m along the front (0 spilling .. 1 a full curl), as linan's tide.js inkCurl: one
 *  continuous rolling wall, never below 0.72, swelling gently per stretch (a raised cosine sized by its hash) */
fn boreCurl(al: f32) -> f32 {
  let P = max(K.bore1.z, 1.0); let fi = floor(al / P); let i = i32(fi);
  let u = al / P - fi;
  return 0.72 + 0.28 * (0.5 - 0.5 * cos(u * 6.2831853)) * (0.55 + 0.45 * boreHash(i * 13 + 5));
}
/** the bore's normal on the ground, turned toward the look's own camera */
fn boreN() -> vec2f {
  let a = K.bore0.xy; let t2 = normalize(K.bore0.zw - a); var n2 = vec2f(-t2.y, t2.x);
  if (dot(K.anchor.xz - a, n2) < 0.0) { n2 = -n2; }
  return n2;
}
/** the painted bore's own frame at P: (m along the front from its first end, m ahead of the crest line (toward the
 *  look's camera; − behind it, the churned side), the local crest height (m), the curl) */
fn boreFrame(P: vec3f) -> vec4f {
  let a = K.bore0.xy; let b = K.bore0.zw; let len = max(length(b - a), 1.0);
  let t2 = (b - a) / len;
  let al = dot(P.xz - a, t2); let c = boreCurl(al);
  let H = mix(K.bore1.x, K.bore1.y, smoothstep(0.3, 1.0, al / len)) * (0.9 + 0.1 * c) * (0.94 + 0.06 * sin(al / 53.0 + 0.7));
  return vec4f(al, dot(P.xz - a, boreN()), H, c);
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let fc = v.pos.xy;
  let uv = fc / K.res.xy;
  let gp = vec2i(fc);
  let bench = u32(K.lv2.w + 0.5);   // (benchmarks: parts left out)
  let uK = K.res.z; let pxA = K.res.w;
  let A = texA(gp); let B = texB(gp); let Cc = textureLoad(gC, gp, 0);
  let cls = clsOf(A);
  let D = depthOf(A);
  let dirW = relDir(uv);
  let P = select(dirW * 1e5, relPosOf(uv, D), A.z > 0.0) + F.eye.xyz;
  let hasN = A.z > 0.0;
  let Nv = octDecode(A.xy);
  let Nw = worldNormal(A);
  let fp = D * pxA;                                   // metres per output px
  let camR = K.axisR.xyz; let camF = K.axisF.xyz;
  let night = K.sh3.y > 0.5;
  let match_ = K.look3.y > 0.0;
  let near = K.sh0.x; let far = K.sh0.y; let cunFar = K.sh0.z; let uMi = K.sh0.w;
  let uRidge = K.sh1.x; let ridgeFrom = K.sh1.y;
  let inkGain = K.st0.x;
  let paperLift = K.sh3.z;
  let tree = isTree(cls) && hasN;
  let Cw = select(vec3f(0.0), originOf(Cc.y), tree || cls == C_LOTUS || cls == C_ROOF);
  let Cr = Cw - F.eye.xyz;

  let rsz = vec2i(textureDimensions(tRidge));
  var RG = textureLoad(tRidge, min(gp / 2, rsz - 1), 0);
  var rdist = RG.r;
  // the far washes grade from a smoothed ridge (trees along a ridge make the distance jump from column to column)
  // (wide: a wooded skyline's ridge jumps from column to column, and a narrow average leaves vertical streaks)
  if (match_ && rdist < 998.0 && D > ridgeFrom * 0.3) {
    var sum = min(rdist, 400.0); var nn = 1.0;
    for (var i = -4; i <= 4; i++) {
      if (i == 0) { continue; }
      let r2 = textureLoad(tRidge, clamp(gp / 2 + vec2i(i32(f32(i) * 6.0 * uK), 0), vec2i(0), rsz - 1), 0).r;
      if (r2 < 998.0) { sum += min(r2, 400.0); nn += 1.0; }
    }
    rdist = sum / nn;
  }
  // ink density: full at the foci and at the base of each mass, thinning toward blank paper elsewhere
  let fK = max(focusOf(K.focus0, uv), focusOf(K.focus1, uv));
  let flo = select(1.0, K.focus0.w, K.focus0.z > 0.0);
  let baseK = 1.0 - smoothstep(10.0, 150.0, RG.g);
  var idk = clamp(mix(flo, 1.0, fK) * (0.8 + 0.35 * baseK), 0.0, 1.1);
  // the foreground (the bottom of the sheet) keeps its full ink
  idk = max(idk, K.look4.x * (1.0 - smoothstep(K.look4.y * 0.4, K.look4.y, 1.0 - uv.y)));

  let PP = paperOf(dirW, uv);
  var paper = PP.rgb; let grain = PP.w;
  paper = mix(paper, vec3f(0.955, 0.95, 0.93) * (0.97 + 0.03 * grain), paperLift * 0.3);

  // ---------------- the sky: its own short path (paper, the painted ranges, clouds, the glow, the night; the lines that
  // spill onto it from the silhouettes), as the general path below paints it
  if (cls == C_SKY) {
    let tFs = smp(tBlur, uv).r; let tBs = smp(tBroad, uv).r;
    var tSs = tFs;
    let sunAng = acos(clamp(dot(dirW, F.sun.xyz), -1.0, 1.0));
    if (night) { tSs = 0.08 + 0.6 * (1.0 - smoothstep(0.016, 0.02, sunAng)) + 0.25 * exp(-sunAng / 0.05); }
    let toneS = pow(clamp(mix(tBs, tFs, 0.35) * K.sh1.z, 0.0, 1.0), K.sh1.w);
    let w0s = pow(clamp((1.0 - toneS - K.st0.z) / (1.0 - K.st0.z), 0.0, 1.0), K.st0.y);
    var w1 = w0s * select(0.1, K.sh2.x * 1.6, night) * inkGain;
    var cl = vec2f(0.0);
    var RNG = vec3f(0.0);
    if (!night) {
      RNG = paintedRanges(dirW);
      if (K.look2.z > 0.0) { cl = cloudsAt(dirW); }
      if (RNG.z > 0.0) { w1 = max(w1, RNG.x * inkGain * (1.0 - 0.8 * cl.x)); }
      // the clouds drawn from the tone, as linan's painter draws its photograph's: a soft grey wash where a cloud's
      // base is darker than the broad tone round it, the lit tops left paper
      let wns = vnoise3(dirW * vec3f(9.0, 30.0, 9.0));
      // (and the shaded base itself, as the targets paint it: a grey wash under each cloud, a breath of grey at its rim)
      if (K.look2.z > 0.0) {
        // (as the references paint fair-weather heaps: the lit tops paper, the bases a soft grey, no outline; the open
        // sky round them a breath of wash so the tops stand out)
        let rimC = smoothstep(0.0, 0.25, cl.x) * (1.0 - smoothstep(0.35, 0.8, cl.x));
        let openSky = 0.12 * smoothstep(0.0, 0.12, dirW.y) * (1.0 - cl.x) * min(K.look2.z * 2.0, 1.0);
        w1 = max(w1 * (1.0 - 0.85 * cl.x) + openSky, K.look2.z * (0.42 * cl.y * (0.7 + 0.3 * wns) + 0.04 * rimC));
      }
    }
    let glowW = K.look5.x * exp(-sunAng / 0.075);
    if (!night) { w1 *= (1.0 - 0.9 * clamp(glowW, 0.0, 1.0)) * select(1.0, 0.5, K.look5.x > 0.0); }
    if (!night && K.look6.w > 0.0) {
      let sEl = asin(clamp(F.sun.y, -1.0, 1.0)); let el = asin(clamp(dirW.y, -1.0, 1.0));
      let d2 = normalize(dirW.xz + vec2f(1e-6, 0.0)); let az = atan2(d2.x, d2.y);
      let cq = vec2f(az * 14.0, (el - sEl) * 95.0);
      let cn = vnoise2(cq) * 0.55 + vnoise2(cq * vec2f(2.6, 1.8) + 4.0) * 0.3 + vnoise2(cq * vec2f(7.0, 3.0) + 9.0) * 0.15;
      let sn = normalize(F.sun.xz + vec2f(1e-6, 0.0)); let sAz = atan2(sn.x, sn.y);
      let dAz = -(fmodp(az - sAz + 3.14159, 6.28318) - 3.14159);
      let win = smoothstep(-0.01, 0.006, el - sEl) * (1.0 - smoothstep(0.035, 0.07, el - sEl)) * smoothstep(0.02, 0.07, dAz) * (1.0 - smoothstep(0.3, 0.45, dAz));
      let band = smoothstep(0.5, 0.68, cn) * win;
      let cu = cq + vec2f(0.0, 0.35);
      let under = smoothstep(0.62, 0.5, vnoise2(cu) * 0.55 + vnoise2(cu * vec2f(2.6, 1.8) + 4.0) * 0.3 + 0.075);
      w1 = max(w1, K.look6.w * band * (0.1 + 0.12 * under) * (1.0 - 0.85 * clamp(glowW * 1.4, 0.0, 1.0)));
    }
    if (night) {
      let sweep = vnoise3(dirW * vec3f(2.0, 14.0, 2.0));
      let moon = smoothstep(0.42, 0.55, tSs);
      let halo = smoothstep(0.12, 0.4, tBs);
      w1 = (0.52 + 0.22 * smoothstep(0.0, 0.45, dirW.y) + 0.035 * (sweep - 0.5)) * K.sh2.x * (1.0 - moon) * (1.0 - 0.35 * halo);
    }
    // (laid flat, in one go; the broad brush's sweep is even on the sky; granulation)
    var inkS = w1 * (1.0 - K.st1.y * 0.5 + K.st1.y * grain);
    let Js = textureLoad(tJfa, gp, 0);
    if (Js.w != 0u && (bench & 1u) == 0u && F_LINES) { let bl = brushLine(Js, fc, idk, fK, grain); inkS += bl.x * 1.5 + bl.y; }
    var absS = vec3f(0.0);
    if (K.look.w > 0.0 && !night) {
      let hz = 1.0 - smoothstep(0.0, 0.35, dirW.y);
      let toSun = pow(max(dot(dirW, F.sun.xyz), 0.0), 6.0);
      absS += (P_ZHE * 0.3 * (0.3 + 0.7 * toSun) + P_TENG * 0.25 * toSun) * K.sh3.x * hz * K.look.w;
    }
    if (K.look5.x > 0.0 && !night) { absS += (P_TENG * 0.17 + P_ZHE * 0.17) * glowW * (1.0 - 0.8 * exp(-sunAng / 0.012)) + (P_ZHE * 0.05 + P_INK * 0.03) * (1.0 - clamp(glowW * 1.5, 0.0, 1.0)); }
    if (K.skyTint.w > 0.0) {
      let up = smoothstep(0.0, 0.45, dirW.y);
      absS += K.skyTint.rgb * K.skyTint.w * (0.25 + 0.75 * up) * select((1.0 - cl.x) * (1.0 - 0.6 * RNG.x), 1.0 - smoothstep(0.42, 0.55, tSs), night);
      if (night) { absS += K.skyTint.rgb * K.skyTint.w * 0.35 * (1.0 - smoothstep(0.42, 0.55, tSs)); }
    }
    if (u32(K.inkAbs.w + 0.5) == 1u) { return vec4f(inkS, cl.x, cl.y, 1.0); }   // (debug view 1 on the sky: its wash, the clouds)
    var colS = paper * exp(-absS) * exp(-K.inkAbs.rgb * K.tint.rgb * inkS * 2.4);
    if (K.look5.x > 0.0 && !night) { colS = mix(colS, vec3f(1.0, 0.985, 0.94), K.look5.x * exp(-sunAng / 0.012) * 0.9); }
    return vec4f(clamp(colS, vec3f(0.0), vec3f(1.0)), 1.0);
  }

  // ---------------- tone → wash
  var tF = smp(tBlur, uv).r; let tB = smp(tBroad, uv).r;
  // (the full-resolution tone only shows the moon's disc in a night sky)
  var tS = tF;
  if (cls == C_SKY && night) {
    let ang = acos(clamp(dot(dirW, F.sun.xyz), -1.0, 1.0));
    tS = 0.08 + 0.6 * (1.0 - smoothstep(0.016, 0.02, ang)) + 0.25 * exp(-ang / 0.05);
  }
  let LL = smp(tLight, uv).rg;
  let sunF = LL.x;
  let plB = smp(tLightB, uv).g;
  var plit = select(smoothstep(0.05, 0.65, sunF), mix(mix(plB, LL.y, 0.3), smoothstep(0.05, 0.65, sunF), 0.3), isLand(cls));
  // a pale ground: the ground, the grass and the paving take the painter's light only, not the trees' cast shadows
  let gLift = K.look5.w > 0.0 && (cls == C_GROUND || cls == C_SMALL || cls == C_PAVE) && !night;
  if (gLift) { plit = mix(plit, mix(plB, LL.y, 0.4), K.look5.w); }
  // (and in every look the ground, the grass, the paving and the carved figures carry no cast shadows: the references
  // paint none, and a wood's shadow on a path or a statue reads as camouflage blotches)
  else if (match_ && !night && (cls == C_GROUND || cls == C_SMALL || cls == C_PAVE || cls == C_FIGURE)) { plit = mix(plB, LL.y, 0.4); }
  let shade = 1.0 - plit;
  let farS = smoothstep(ridgeFrom * 0.5, ridgeFrom, D) * select(0.0, 1.0, isLand(cls) || isFol(cls) || cls == C_CITYFAR);
  tF = mix(tF, tB, farS * 0.5);
  var tone = mix(tB, tF, 0.35);
  if (cls == C_ROOF) { tone = mix(tF, tB, 0.7); }
  else if (isArch(cls)) { tone = mix(tF, tB, 0.3); }
  else if (isTree(cls) || cls == C_WATER || cls == C_SMALL) { tone = mix(tB, tF, 0.2); }
  else if (cls == C_LOTUS) { tone = mix(tB, tF, 0.6); }
  tone = pow(clamp(tone * K.sh1.z, 0.0, 1.0), K.sh1.w);
  // rock and ground: the value follows the light on the form, not the material's blotches
  if (isLand(cls) && hasN && !night) {
    var litT = select(0.15, 0.0, cls == C_ROCK) + 0.82 * smoothstep(0.3, 0.85, plit);
    if (cls == C_FIGURE) { litT = 0.62 + 0.36 * smoothstep(0.1, 0.9, plit); }
    tone = mix(tone, mix(pow(clamp(tB * K.sh1.z, 0.0, 1.0), K.sh1.w), litT, select(0.8, mix(0.8, 1.0, K.look5.w), gLift)), 1.0 - smoothstep(ridgeFrom * 0.4, ridgeFrom, D));
  }
  let dark = 1.0 - tone;
  var w0 = pow(clamp((dark - K.st0.z) / (1.0 - K.st0.z), 0.0, 1.0), K.st0.y);
  // a crown is one soft mass: a light wash over it, deeper on the shaded underside, in clumps (墨分五色)
  var clumpB = 0.0; var clumpBody = 1.0; var crownW = -1.0;
  if (tree && !night) {
    let under = smoothstep(0.0, 1.0, (Cw.y + 9.0 - P.y) / 9.0);
    w0 = max(w0, (0.22 + 0.38 * max(shade, under * 0.75)) * select(1.0, 0.5, cls == C_WILLOW) * K.look.y);
    // (willow and blossom crowns are left paper, as the references leave them: their threads, limbs and flowers
    // carry them)
    // (far off, where its holes close, a flowering crown is a soft pale mass)
    if (match_ && cls == C_BLOSSOM) { crownW = mix(0.012 + 0.03 * shade, 0.1 + 0.14 * shade, smoothstep(0.06, 0.12, D * pxA)); w0 = crownW; }
    // (where its threads get finer than a few pixels, a willow is a soft grey mass, as the references' far willows)
    if (match_ && cls == C_WILLOW) {
      let fw = smoothstep(0.035, 0.1, length(Cr) * pxA * uK / max(scaleOf(Cc.y), 0.3));
      crownW = mix(0.02 + 0.045 * shade + 0.02 * under, 0.14 + 0.16 * shade + 0.06 * under, fw); w0 = crownW;
    }
    if (match_ && cls != C_BLOSSOM && cls != C_WILLOW) {
      // a wood as the references paint it: each crown one dark mass, deeper underneath and on its shaded side (the
      // light taken broad: the crown's cards would break a fine one into facets), clumps only a little deeper than the
      // body, small paper gaps where the light falls; each tree a shade of its own (墨分五色)
      let O = Cw;
      let fpo = length(Cr) * pxA * uK;
      let hs = h13(vec3i(floor(O * 1.7)) + 91);
      let lp = vec2f(dot(P - O, camR), P.y - O.y);
      let shC = 1.0 - smoothstep(0.1, 0.75, mix(plB, sunF, 0.25));
      let S = max(select(2.2, 1.6, cls == C_PINE), fpo * 14.0);
      var sq = vec2f(1.0, 1.25);
      if (cls == C_PINE) { sq = vec2f(0.8, 2.0); }
      let g = lp * sq / S + hs * 37.0;
      let gU = g + vec2f(0.0, 0.3);
      let n0 = vnoise2(g) * 0.7 + vnoise2(g * 2.3 + 5.0) * 0.3;
      let nU = vnoise2(gU) * 0.7 + vnoise2(gU * 2.3 + 5.0) * 0.3;
      clumpBody = smoothstep(0.28, 0.52, n0);
      clumpB = clamp((nU - n0) * 6.0, 0.0, 1.0) * clumpBody;
      let grove = smoothstep(0.28, 0.72, vnoise2(O.xz / 55.0 + 3.3) * 0.7 + vnoise2(O.xz / 21.0 + 8.1) * 0.3);
      let t5 = (0.86 + 0.28 * hs) * mix(0.85, 1.12, grove);
      crownW = (0.36 + 0.34 * shC + 0.16 * under + 0.12 * clumpB) * mix(0.82, 1.0, clumpBody) * t5;
      if (cls == C_PINE) { crownW = crownW * 1.12 + 0.06; }
      if (cls == C_MAPLE || cls == C_GINKGO) { crownW *= 0.62; }
      // (the lit gaps: small dabs of paper on the side toward the light)
      // (cheap: two lookups of noise, thresholded into small blobs by the light)
      let gq = (lp + vec2f(17.3, 5.1)) / max(fpo * 5.0, 0.3) + hs * 53.0;
      let gap = smoothstep(0.66, 0.74, vnoise2(gq) * 0.75 + vnoise2(gq * 2.7 + 3.3) * 0.25 + 0.22 * (1.0 - shC) * clumpBody - 0.12);
      crownW *= 1.0 - 0.55 * gap;
      w0 = crownW;
    }
  }
  if (cls == C_IVY && !night) { w0 = 0.42 + 0.25 * shade; }
  if (cls == C_BARK && !night && match_) { w0 = max(w0, 0.55 + 0.3 * shade); }
  // buildings modelled in tone as the references' 界画 are, not white fills inside outlines: walls and timber grey
  // in shade, the undersides of the eaves and the brackets dark
  if (match_ && !night && (cls == C_WALL || cls == C_WOOD || cls == C_STONE || cls == C_DARK) && hasN) {
    let eaveU = smoothstep(-0.15, -0.6, Nw.y);
    w0 = max(w0, select(0.05, 0.08, cls == C_WOOD || cls == C_DARK) + 0.2 * shade + 0.42 * eaveU);
  }
  // a slab path as the references paint it: each slab its own flat grey (the G-buffer's slab id), the joints dark
  if (cls == C_PAVE && !night) {
    let blk = bitcast<f32>(Cc.w);
    w0 = 0.12 + 0.08 * shade + select(0.0, 0.1 * (blk - 0.5), blk >= 0.0 && match_);
  }
  if (cls == C_BLOOM && !night) { w0 = 0.01 + 0.06 * shade; }
  if (cls == C_LOTUS && !night) { w0 = 0.5 + 0.3 * shade + 0.15 * smoothstep(0.4, 0.95, 1.0 - abs(Nw.y)); }
  // roofs: each plane one flat wash (界画), set by the painter's light, not by the cast shadows
  if ((cls == C_ROOF || cls == C_CITYFAR) && !night) { w0 = mix(0.78, 0.44, smoothstep(0.2, 0.85, LL.y)); }
  // snow lying on what faces up — roofs, a bridge's deck and parapet tops, stone, timber — left as paper, as ink10 leaves
  // the pavilion's roof and the 断桥 white; the eaves' edges and the faces below keep their ink
  let snowTop = select(0.0, smoothstep(0.3, 0.6, Nw.y), paperLift > 0.5 && !night && hasN && match_ && (isArch(cls) || cls == C_ROCK));
  w0 = mix(w0, 0.025, snowTop);
  // 墨分五色 over a city: each building's roof its own depth of ink
  if (cls == C_ROOF && !night && K.mpatch.y > 0.0) {
    let bh = h13(vec3i(floor(Cw * 0.5)) + 313);
    w0 *= mix(1.0, select(select(0.4, 1.0, bh < 0.6), 1.9, bh < 0.22), K.mpatch.y);
  }
  // rock: graded grey washes laid in wet mottled patches, deeper in shade and toward the foot, cut by vertical
  // fissures; the niche a mid-grey hollow; the carving pale stone modelled only at its turning edges
  var facetLine = 0.0; var facetV = 0.0;
  let nearR = 1.0 - smoothstep(ridgeFrom * 0.3, ridgeFrom * 0.8, D);
  if ((cls == C_ROCK || cls == C_NICHE) && !night && hasN && F_ROCK) {
    let fc2 = facets(P, Nw, fp, 150.0);
    facetV = fc2.x;
    var pv = smoothstep(0.15, 0.85, mix(plB, smoothstep(0.05, 0.65, sunF), 0.3));
    let vv = (pv * 0.9 + fc2.x * 0.9 + (tB - 0.4) * 0.6 - 0.04) * 3.0;
    let lv = clamp(floor(vv) + smoothstep(0.42, 0.58, fract(vv)), 0.0, 3.0);
    var rw = mix(0.62, 0.1, lv / 3.0) + 0.18 * baseK;
    if (cls == C_NICHE) { rw = mix(0.62, 0.36, smoothstep(0.15, 0.6, tF)) + 0.1 * (1.0 - pv); }
    facetLine = fc2.y * nearR * (0.4 + 0.6 * shade) * select(0.8, 0.3, cls == C_NICHE) * K.look2.x;
    if (match_) {
      let fis = fissures(P, fp);
      let mot = lodNoise(P * vec3f(1.0, 0.45, 1.0) + 17.0, fp * 70.0 * uK);
      let mot2 = lodNoise(P * vec3f(1.0, 0.3, 1.0) + 3.0, fp * 22.0 * uK);
      pv = smoothstep(0.15, 0.85, mix(plB, smoothstep(0.05, 0.65, sunF), 0.1));
      // (the references' rock is the deepest ink in the picture after the pines: grey on the lit faces, near black in
      // the shaded ones and the clefts)
      rw = 0.26 + 0.38 * (1.0 - pv) + 0.22 * (mot - 0.5) + 0.1 * (mot2 - 0.5) + 0.14 * baseK + 0.32 * fis.y + 0.12 * fc2.x;
      if (cls == C_NICHE) { rw = 0.3 + 0.12 * (1.0 - pv) + 0.1 * (mot - 0.5) + 0.12 * smoothstep(0.35, 0.05, tF); }
      facetLine = max(fc2.y * 0.3, fis.x) * nearR * (0.6 + 0.4 * shade) * select(1.0, 0.35, cls == C_NICHE) * K.look2.x;
      // the face's own 皴: dry vertical streaks of the side brush, gathered in groups, deeper in shade
      let rq = vec2f(dot(P, camR), P.y);
      let rl = log2(fp * 26.0 * uK); let rl0 = floor(rl);
      let rs = mix(streakLevel(rq, vec2f(0.0, -1.0), exp2(rl0), 0.35 + 0.35 * shade, 1.0, rl0 + 40.0),
                   streakLevel(rq, vec2f(0.0, -1.0), exp2(rl0 + 1.0), 0.35 + 0.35 * shade, 1.0, rl0 + 41.0), smoothstep(0.0, 1.0, rl - rl0));
      facetLine = max(facetLine, rs * 0.32 * nearR * select(1.0, 0.4, cls == C_NICHE));
    }
    w0 = mix(w0, rw, nearR);
  }
  if (cls == C_FIGURE && !night) {
    // the carving is the cliff's own grey stone (ink08): a pale grey on the lit belly and face, a mid grey turning
    // away and in shade, deep in the folds and the hollows, mottled by the weather — not paper with an outline
    let rimV = pow(1.0 - clamp(abs(dot(Nw, dirW)), 0.0, 1.0), 1.5);
    // (lit from its own form: the light buffers carry the leaves' dappled shadows)
    let pv = smoothstep(-0.2, 0.8, 0.6 * dot(Nw, F.sun.xyz) + 0.4 * Nw.y);
    let mot = lodNoise(P * vec3f(1.0, 0.7, 1.0) + 41.0, fp * 60.0 * uK);
    let mot2 = lodNoise(P * 2.3 + 9.0, fp * 18.0 * uK);
    w0 = mix(w0, 0.07 + 0.24 * (1.0 - pv) + 0.12 * rimV + 0.1 * (mot - 0.5) + 0.05 * (mot2 - 0.5), nearR);
  }
  // far ranges: pale washes keyed to their (small) contrast against the haze
  let farW = smoothstep(ridgeFrom * 0.5, ridgeFrom, D) * select(0.0, 1.0, isLand(cls) || isFol(cls) || cls == C_CITYFAR);
  let wFar = pow(clamp((dark - 0.03) * 1.9, 0.0, 1.0), 1.1) * 0.6;
  w0 = mix(w0, max(w0, wFar), farW);
  // far masses: one graded wash per range, deepest under its ridge and paling downward into the mist at its foot
  var wGeo = 0.0;
  if (farW > 0.0 && match_) {
    let dk = 1.0 - 0.8 * smoothstep(ridgeFrom, ridgeFrom * 7.0, D);
    let rgd = exp(-rdist / max(uRidge * 1.7, 1.0));
    let mot = lodNoise(P * vec3f(1.0, 0.6, 1.0) + 5.0, fp * 110.0 * uK);
    let wPh = pow(clamp((1.0 - pow(clamp(tB * K.sh1.z, 0.0, 1.0), K.sh1.w) - 0.03) * 1.9, 0.0, 1.0), 1.1) * 0.5;
    // (a far wood is a mid-grey mass that pales with distance, deepest under its crest: not paper with a dark rim)
    wGeo = 0.38 * dk * (0.62 + 0.38 * rgd) * (0.8 + 0.4 * shade) * (0.8 + 0.4 * mot) * select(1.0, 1.2, isFol(cls));
    wGeo = mix(wGeo, max(wGeo, wPh * dk), 0.35) * inkGain;
    wGeo *= 1.0 - 0.75 * paperLift;
  }
  var mul = 1.0;
  var RNG = vec3f(0.0);
  if (cls == C_SKY && !night) { RNG = paintedRanges(dirW); }
  if (cls == C_SKY) { mul = select(0.1, K.sh2.x * 1.6, night); }
  else if (cls == C_WATER) { mul = K.sh2.y * mix(0.35, 1.0, exp(-RG.b / 40.0)); }
  else if (crownW >= 0.0) { mul = 1.0; }
  else if (cls == C_PINE) { mul = 0.5; }
  else if (cls == C_WILLOW) { mul = mix(0.16, 0.4, farW); }
  else if (cls == C_MAPLE) { mul = 0.5; }
  else if (cls == C_GINKGO) { mul = mix(0.3, 0.5, farW); }
  else if (isTree(cls)) { mul = mix(0.34, 0.5, farW); }
  // near flat ground is the paper itself; slopes and banks take the wash
  else if (cls == C_GROUND) { mul = mix(mix(0.4 * K.look2.y, 1.0, smoothstep(0.12, 0.5, 1.0 - Nw.y)), 1.0, farW); }
  else if (cls == C_SMALL) { mul = select(0.08, 0.3, match_); }
  else if (cls == C_IVY || cls == C_PAVE || cls == C_BLOOM) { mul = 1.0; }
  else if (cls == C_LOTUS) {
    let lh = mix(h13(vec3i(floor(Cw * 3.1)) + 57), smoothstep(0.2, 0.8, lodNoise(vec3f(P.x, 0.0, P.z) + 9.0, 1.6)), 0.55);
    mul = (0.12 + 1.0 * lh * lh) * mix(1.15, 0.45, smoothstep(near * 0.5, near * 3.0, D)) * mix(0.35, 1.0, idk);
  }
  else if (cls == C_WALL || cls == C_SNOW) { mul = select(0.5, 0.75, cls == C_WALL && match_); }
  else if (cls == C_ROOF || cls == C_CITYFAR) { mul = 0.72; }
  else if (cls == C_DARK) { mul = 0.65; }
  else if (isArch(cls)) { mul = 0.62; }
  var wn = lodNoise(P, fp * 45.0 * uK);
  if (cls == C_SKY) { wn = vnoise3(dirW * vec3f(9.0, 30.0, 9.0)); }
  if (isTree(cls)) { mul *= K.look.y; }
  if (cls == C_ROCK || cls == C_NICHE) { mul *= K.look2.x; }
  if (cls == C_ROOF || cls == C_CITYFAR) { mul *= K.look.z; }
  // aerial perspective: everything pales with distance (the paper shows through)
  if (cls != C_SKY) { mul *= mix(1.0, 0.5, smoothstep(near * 2.0, far * 1.2, D)); }
  if (cls != C_SKY && cls != C_WATER && cls != C_FIGURE) { mul *= select(mix(select(0.55, 0.55, match_), 1.0, idk), mix(select(0.6, 0.62, match_), 1.0, idk), isArch(cls)); }
  // range behind range: each farther one paler
  if (isLand(cls) || isFol(cls)) { mul *= mix(1.0, 0.4, smoothstep(ridgeFrom * 1.5, ridgeFrom * 10.0, D)); }
  var w1 = w0 * mul * inkGain;
  if (wGeo > 0.0) { w1 = mix(w1, wGeo, farW); }
  // the ground is not blank paper: broad patches of pale wash and dry horizontal 擦 strokes, deeper toward the focus
  // and at the foot of what stands on it (the ground plane's own axes, the look's foreshortening)
  if ((cls == C_GROUND || cls == C_SMALL) && !night && paperLift < 0.5 && (bench & 4u) == 0u && F_GROUND) {
    let gq = vec2f(dot(P.xz, normalize(camR.xz)), dot(P.xz, normalize(camF.xz)));
    let Ds = length(P - F.eye.xyz);
    let sinG = mix(clamp((K.anchor.y - P.y) / max(length(P - K.anchor.xyz), 1.0), 0.03, 1.0), K.axisR.w, K.axisF.w);
    let fps = Ds * pxA;
    let l = log2(fps * 40.0 * uK); let l0 = floor(l);
    // the foreshortening quantised to powers of two and blended (applied directly it would vary from pixel to pixel
    // over coordinates of thousands of metres: stripes that flicker in motion)
    let ks = log2(sinG * 1.5); let ks0 = floor(ks); let kt = smoothstep(0.0, 1.0, ks - ks0);
    let kA = exp2(ks0); let kB = kA * 2.0;
    let lt = smoothstep(0.0, 1.0, l - l0);
    // (each blend evaluates only the levels it weighs: most pixels lie well inside one)
    var patchN = 0.0; var p2n = 0.0; var st = 0.0;
    for (var kk = 0; kk < 2; kk++) {
      let wk = select(kt, 1.0 - kt, kk == 0);
      if (wk < 0.01) { continue; }
      let kf = select(kB, kA, kk == 0);
      patchN += wk * lodNoise(vec3f(gq.x, 0.0, gq.y * kf) + 31.0, fps * 260.0 * uK);
      p2n += wk * lodNoise(vec3f(gq.x, 0.0, gq.y * kf * 1.6667) + 57.0, fps * 90.0 * uK);
      let sq = vec2f(gq.x, gq.y * kf);
      var stk = 0.0;
      if (lt < 0.99) { stk += (1.0 - lt) * streakLevel(sq, vec2f(1.0, 0.0), exp2(l0), 0.16, 1.0, l0); }
      if (lt > 0.01) { stk += lt * streakLevel(sq, vec2f(1.0, 0.0), exp2(l0 + 1.0), 0.16, 1.0, l0 + 1.0); }
      st += wk * stk;
    }
    // the stills' fine horizontal hatching (a still measures the ground's lattice from the eye, pixel by pixel, and
    // the rows come out of that; linan's tour video draws them on purpose): projected from the look's own camera, as a
    // projector throws a slide — sheet px as seen from there, so at the viewpoint they keep a still's size, and as the
    // eye walks off they stay on the ground and give way once their rows pass a few pixels (the eye's distance alone)
    let V = P - K.anchor.xyz;
    let pq = vec2f(atan2(dot(V.xz, normalize(camR.xz)), max(dot(V.xz, normalize(camF.xz)), 0.01)), atan2(-V.y, max(length(V.xz), 0.01))) / (pxA * uK);
    let rowPx = 2.2 * uK * length(V) / max(Ds, 1e-3);
    let hk = smoothstep(0.9, 1.6, rowPx) * (1.0 - smoothstep(5.0, 10.0, rowPx)) * step(0.02, dot(V.xz, normalize(camF.xz))) * select(0.0, 1.0, cls == C_GROUND);
    if (hk > 0.0) {
      let hatch = hatchRows(pq, 1.0);
      patchN = mix(patchN, 0.3 + 0.65 * hatch * (0.6 + 0.8 * smoothstep(0.25, 0.75, patchN)), 0.85 * hk);
    }
    let p2 = smoothstep(0.35, 0.75, p2n);
    let patches = smoothstep(0.3, 0.8, patchN);
    let nearG = 1.0 - smoothstep(far * 0.25, far * 0.7, Ds);
    // (even, as the references' banks: the patches only a little deeper, never pale holes)
    let gw = (0.16 + 0.07 * patches + 0.05 * p2 + 0.06 * st * patches + 0.12 * baseK + 0.08 * shade) * mix(0.6, 1.0, idk) * nearG * min(K.look2.y, 2.5);
    w1 = max(w1, gw * inkGain);
  }
  // snow scenes: the water and the bark are inked so the snow can be left as paper (烘托)
  if (paperLift > 0.5 && !night) {
    if (cls == C_WATER) {
      let ws = vec3f(dot(P, camR) * 0.12, 0.0, dot(P, camF));
      let sweep = lodNoise(ws + 7.7, fp * 30.0 * uK);
      let nearW = smoothstep(near * 2.0, near * 12.0, D);
      w1 = (0.03 + 0.05 * nearW + 0.24 * exp(-RG.b / 40.0) + 0.05 * (sweep - 0.5)) * inkGain;
      if (match_) { w1 = (0.025 + 0.02 * nearW + 0.2 * exp(-RG.b / 28.0) + 0.03 * (sweep - 0.5)) * inkGain; }
    }
    if (cls == C_BARK) { w1 = mix(0.75, 0.0, smoothstep(0.05, 0.45, Nw.y)) * inkGain; }
    if (cls == C_GROUND) { w1 = max(w1, 0.45 * exp(-RG.g / 9.0) * smoothstep(0.6, 0.2, Nw.y + 0.3 * lodNoise(P + 2.0, fp * 20.0 * uK)) * inkGain); }
    if (cls == C_WILLOW) { w1 = max(w1, (0.2 + 0.15 * shade) * mix(0.6, 1.0, idk) * inkGain); }
    if (isFol(cls) && cls != C_WILLOW) { w1 *= mix(1.3, 0.25, smoothstep(-0.1, 0.5, Nw.y)); }
  }
  // the sky: the far ranges painted on it, clouds (fixed to the world: their shaded undersides a soft grey wash)
  var cl = vec2f(0.0);
  if (cls == C_SKY && !night) {
    if (K.look2.z > 0.0) { cl = cloudsAt(dirW) * min(1.0, K.look2.z * 2.0); }
    if (RNG.z > 0.0) { w1 = max(w1, RNG.x * inkGain * (1.0 - 0.8 * cl.x)); }
    w1 = max(w1 * (1.0 - 0.7 * cl.x), 0.32 * cl.y);
  }
  // open water by day (ink-match): a pale wash laid in long strokes, the sun's path and glints left paper
  var sunPath = 0.0;
  if (cls == C_WATER && !night && paperLift < 0.5 && K.look3.x > 0.0) {
    var path = 0.0;
    if (K.moonCol.x > 0.0) {
      let mz = normalize(F.sun.xz + vec2f(1e-6, 0.0)); let dz = normalize(dirW.xz + vec2f(1e-6, 0.0));
      let dAz = abs(atan2(mz.x * dz.y - mz.y * dz.x, dot(mz, dz)));
      let below = max(-dirW.y, 0.0);
      let wob = lodNoise(vec3f(dot(P, camF) * 1.7, 0.0, 3.0), fp * 6.0 * uK) - 0.5;
      let core = 1.0 - smoothstep(select(0.35, 0.0, match_), 1.0, dAz / (K.moonCol.y + K.moonCol.z * below) + 0.5 * wob);
      let rows = lodNoise(vec3f(dot(P, camR) * 0.3, 0.0, dot(P, camF) * 3.2) + 9.0, fp * 5.0 * uK);
      path = core * smoothstep(0.56 - 0.2 * core, 0.64 - 0.16 * core, rows) * K.moonCol.x;
      if (match_) { path = core * core * mix(0.55, 1.0, smoothstep(0.4, 0.7, rows)) * K.moonCol.x; }
      if (K.look5.x > 0.0) {
        let nearSun = 1.0 - smoothstep(0.0, 0.05, below);
        path = core * mix(smoothstep(0.5 - 0.15 * core, 0.6 - 0.12 * core, rows), 1.0, 0.25 + 0.6 * nearSun * core) * K.moonCol.x;
      }
      sunPath = path;
    }
    w1 = K.look3.x * (0.75 + 0.5 * wn) * (1.0 - min(path * (1.0 + 0.4 * K.look5.x), 1.0)) * inkGain;
    // the shore's reflection: the broad tone of what stands above the shore line, mirrored about it, laid as a soft
    // wash in horizontal strokes that fades away from the shore (the dark woods hang in the water)
    if (match_ && RG.b < 998.0) {
      let muv = uv - vec2f(0.0, 2.0 * RG.b * uK / K.res.y);
      let rl = min(smp(tBroad, muv).r, min(smp(tBroad, muv - vec2f(0.0, 14.0 * uK / K.res.y)).r, smp(tBroad, muv - vec2f(0.0, 30.0 * uK / K.res.y)).r));
      let rt = pow(clamp(rl * K.sh1.z, 0.0, 1.0), K.sh1.w);
      var rk = exp(-RG.b / (45.0 + 25.0 * K.look5.x)) * (1.0 - smoothstep(150.0, 235.0, RG.b) * step(0.001, K.look5.x)) * (0.75 + 0.5 * lodNoise(vec3f(dot(P, camR) * 0.08, 0.0, dot(P, camF)) + 5.5, fp * 30.0 * uK));
      rk *= K.waterRefl.x * select(1.0, exp(-RG.b / K.waterRefl.y), K.waterRefl.y > 0.0);
      w1 = max(w1, smoothstep(0.25, 0.75, 1.0 - rt) * 0.75 * rk * (1.0 - 0.7 * path) * inkGain);
    }
  }
  // a low sun's halo: the sky round the sun left paper; the forms right in front of it veiled
  let sunAng = acos(clamp(dot(dirW, F.sun.xyz), -1.0, 1.0));
  let glowW = K.look5.x * exp(-sunAng / 0.075); let glowS = K.look5.x * exp(-sunAng / 0.035);
  if (cls == C_SKY && !night) { w1 *= (1.0 - 0.9 * clamp(glowW, 0.0, 1.0)) * select(1.0, 0.5, K.look5.x > 0.0); }
  // soft bands of cloud low over the evening sky, paling into the glow round the sun (directions only)
  if (cls == C_SKY && !night && K.look6.w > 0.0) {
    let sEl = asin(clamp(F.sun.y, -1.0, 1.0)); let el = asin(clamp(dirW.y, -1.0, 1.0));
    let d2 = normalize(dirW.xz + vec2f(1e-6, 0.0)); let az = atan2(d2.x, d2.y);
    let cq = vec2f(az * 14.0, (el - sEl) * 95.0);
    let cn = vnoise2(cq) * 0.55 + vnoise2(cq * vec2f(2.6, 1.8) + 4.0) * 0.3 + vnoise2(cq * vec2f(7.0, 3.0) + 9.0) * 0.15;
    let sn = normalize(F.sun.xz + vec2f(1e-6, 0.0)); let sAz = atan2(sn.x, sn.y);
    let dAz = -(fmodp(az - sAz + 3.14159, 6.28318) - 3.14159);
    let win = smoothstep(-0.01, 0.006, el - sEl) * (1.0 - smoothstep(0.035, 0.07, el - sEl)) * smoothstep(0.02, 0.07, dAz) * (1.0 - smoothstep(0.3, 0.45, dAz));
    let band = smoothstep(0.5, 0.68, cn) * win;
    let cu = cq + vec2f(0.0, 0.35);
    let under = smoothstep(0.62, 0.5, vnoise2(cu) * 0.55 + vnoise2(cu * vec2f(2.6, 1.8) + 4.0) * 0.3 + 0.075);
    w1 = max(w1, K.look6.w * band * (0.1 + 0.12 * under) * (1.0 - 0.85 * clamp(glowW * 1.4, 0.0, 1.0)));
  }
  // (a building's own material can be near black — a brick pagoda's albedo 0.07 — but the references keep walls and
  // timber mid-grey, the eaves' shade the darkest part)
  if (isArch(cls)) { w1 = min(w1, select(select(0.34, 0.22 + 0.26 * smoothstep(-0.15, -0.6, Nw.y), match_), select(0.42, 0.7, K.mpatch.y > 0.0) * K.look.z, cls == C_ROOF)); }
  // a far building (a pagoda across the lake) a dark silhouette in the haze
  if (match_ && isArch(cls) && !night) { w1 = max(w1, 0.36 * smoothstep(ridgeFrom * 0.8, ridgeFrom * 1.6, D) * inkGain); }
  // night: an ink night, dark and flat; the moon a clean disc of paper in a soft lighter halo; the lake a wash a
  // little lighter than the sky with the moon's path as broken strokes of paper; the far shore a dark band
  var glint = 0.0;
  if (cls == C_SKY && night) {
    let sweep = vnoise3(dirW * vec3f(2.0, 14.0, 2.0));
    let moon = smoothstep(0.42, 0.55, tS);
    let halo = smoothstep(0.12, 0.4, tB);
    w1 = (0.52 + 0.22 * smoothstep(0.0, 0.45, dirW.y) + 0.035 * (sweep - 0.5)) * K.sh2.x * (1.0 - moon) * (1.0 - 0.35 * halo);
  }
  if (cls == C_WATER && night) {
    let ws = vec3f(dot(P, camR) * 0.08, 0.0, dot(P, camF));
    let sweep = lodNoise(ws + 4.1, fp * 40.0 * uK);
    var path = 0.0;
    if (K.moonCol.x > 0.0) {
      let mz = normalize(F.sun.xz + vec2f(1e-6, 0.0)); let dz = normalize(dirW.xz + vec2f(1e-6, 0.0));
      let dAz = abs(atan2(mz.x * dz.y - mz.y * dz.x, dot(mz, dz)));
      let below = max(-dirW.y, 0.0);
      let hw = K.moonCol.y + K.moonCol.z * below;
      let wob = lodNoise(vec3f(dot(P, camF) * 1.7, 0.0, 3.0), fp * 6.0 * uK) - 0.5;
      let core = 1.0 - smoothstep(0.35, 1.0, dAz / hw + 0.5 * wob);
      let rows = lodNoise(vec3f(dot(P, camR) * 0.3, 0.0, dot(P, camF) * 3.2) + 9.0, fp * 5.0 * uK);
      let dash = smoothstep(0.56 - 0.2 * core, 0.64 - 0.16 * core, rows);
      let nearMoon = 1.0 - smoothstep(0.0, 0.12, below);
      path = core * mix(dash, 1.0, 0.4 * nearMoon * core) * K.moonCol.x;
      // the lanterns' lit openings mirrored about the waterline above (the shore / object base, RG.b px up): a
      // small glint stretched down the water and broken by the ripples
      if (match_ && K.sh3.w > 0.0 && RG.b < 240.0) {
        let wb = (lodNoise(vec3f(dot(P, camR) * 0.6, 0.0, dot(P, camF) * 5.0) + 2.0, fp * 4.0 * uK) - 0.5) * 3.0 * uK;
        var hit = 0.0;
        for (var k = -2; k <= 2; k++) {
          let mp = fc + vec2f(wb, -(2.0 * RG.b * uK + f32(k) * 2.0 * uK));
          if (clsOf(texA(vec2i(mp))) == C_GLOW) { hit = max(hit, 1.0 - abs(f32(k)) * 0.2); }
        }
        let dsh = smoothstep(0.4, 0.55, lodNoise(vec3f(dot(P, camR) * 0.3, 0.0, dot(P, camF) * 2.2) + 7.0, fp * 6.0 * uK));
        glint = hit * mix(dsh, 1.0, 0.35) * K.moonCol.w * K.sh3.w;
      }
    }
    sunPath = path;
    let nearW = 1.0 - smoothstep(30.0, 600.0, D);
    w1 = (0.36 + 0.1 * nearW + 0.05 * (sweep - 0.5)) * K.sh2.x * (1.0 - 0.95 * max(path, glint));
  }
  if (night) {
    if (isLand(cls) || isFol(cls) || cls == C_CITYFAR) { w1 = (select(0.62, 0.78, cls == C_WILLOW) - 0.22 * exp(-RG.g / 14.0)) * K.sh2.x * mix(1.0, 0.75, smoothstep(far * 0.2, far, D)); }
    if (cls == C_ROOF) { w1 = 0.5 * K.sh2.x; }
    if (cls == C_WOOD || cls == C_DARK) { w1 = 0.42 * K.sh2.x; }
    if (cls == C_WALL) { w1 = 0.26 * K.sh2.x; }
    if (cls == C_STONE || cls == C_METAL) {
      w1 = select(0.05 + 0.1 * shade, (0.5 + 0.14 * shade - 0.18 * smoothstep(0.2, 0.6, tF)) * K.sh2.x, K.moonCol.x > 0.0);
      if (K.moonCol.x > 0.0 && match_) {
        // the lantern stones dark, the moon catching their rounded tops and the rims of their tiers
        let top = smoothstep(0.2, 0.8, Nw.y);
        let under = smoothstep(-0.2, -0.7, Nw.y);
        let pl = smoothstep(0.25, 0.85, LL.y);
        let mot = lodNoise(P * vec3f(1.0, 2.0, 1.0) + 3.3, max(fp * 18.0 * uK, 0.02));
        w1 = (0.98 - 0.42 * pl - 0.18 * top + 0.15 * under + 0.16 * (mot - 0.5)) * K.sh2.x;
      }
    }
    if (cls == C_GLOW) { w1 = 0.0; }
  }
  // the wash edge feathers into the paper's fibres (洇)
  let LAY = K.st0.w;
  let q = w1 * LAY + (wn - 0.5) * 0.6 + (grain - 0.5) * 0.08;
  let fl = floor(q); let fr = q - fl;
  let layered = (fl + smoothstep(0.38, 0.62, fr)) / LAY;
  let rim = smoothstep(0.45, 0.6, fr) * (1.0 - smoothstep(0.6, 0.95, fr)) * step(0.0, fl) * step(0.02, w1);
  var wash = max(mix(w1, layered, select(select(0.5, 0.2, isFol(cls)), 0.25, isArch(cls))), 0.0)
           + rim * K.st1.x / LAY * select(select(1.0, 0.0, isFol(cls) && cls != C_LOTUS), 0.3, cls == C_ROCK || cls == C_FIGURE);
  // a sky wash (and a roof plane) is laid flat, in one go
  if (cls == C_SKY || cls == C_LOTUS || cls == C_GLOW || (night && (isArch(cls) || isLand(cls) || isFol(cls)))
      || (cls == C_WATER && (night || paperLift > 0.5 || K.look5.x > 0.0 || K.waterRefl.y > 0.0)) || cls == C_ROOF || cls == C_CITYFAR
      || ((cls == C_ROCK || cls == C_NICHE || cls == C_FIGURE) && nearR > 0.5) || (cls == C_PAVE && match_)) { wash = w1; }

  // far ranges: dark at the ridge, fading downward into mist (留白)
  let farK = smoothstep(ridgeFrom * 0.7, ridgeFrom * 1.4, D) * select(0.0, 1.0, uRidge > 0.0 && cls != C_SKY && cls != C_WATER);
  let ridgeFade = exp(-rdist / max(uRidge, 1.0) * (0.8 + 0.4 * wn));
  if (match_) { wash = mix(wash, wash * (0.25 + 0.75 * ridgeFade) + 0.04 * exp(-rdist / max(uRidge * 0.35, 1.0)) * smoothstep(0.02, 0.2, w0), farK * 0.6); }
  else { wash = mix(wash, wash * (0.08 + 0.92 * ridgeFade) + 0.12 * exp(-rdist / max(uRidge * 0.18, 1.0)) * smoothstep(0.02, 0.2, w0), farK); }
  // 留白: mist lying low below a height, and in bands at distances from the look's camera
  var mist = 0.0;
  let MB = K.mistBand;
  if (MB.w > 0.0 && cls != C_SKY && cls != C_WATER) {
    let mn = lodNoise(P * vec3f(1.0, 4.0, 1.0) + 11.0, max(fp * 120.0 * uK, 2.0));
    mist = clamp((1.0 - smoothstep(MB.x, MB.y, P.y + (mn - 0.5) * (MB.y - MB.x) * 1.2)) * smoothstep(MB.z, MB.z * 1.6, D) * MB.w, 0.0, 1.0);
  }
  if (cls != C_SKY) {
    let bn = lodNoise(P * vec3f(1.0, 3.0, 1.0) + 23.0, max(fp * 90.0 * uK, 4.0));
    let bandK = select(1.0, 0.45, match_ && (isArch(cls) || cls == C_CITYFAR));
    mist = max(mist, bandK * max(bandOf(K.band0, P, bn), max(bandOf(K.band1, P, bn), bandOf(K.band2, P, bn))));
    // low mist lying in patches among the blocks (world-anchored), so the city is not a regular grid
    if (K.mpatch.x > 0.0) {
      let pn = vnoise2(P.xz / K.mpatch.x + 3.7) * 0.7 + vnoise2(P.xz / (K.mpatch.x * 0.37) + 9.1) * 0.3;
      let low = 1.0 - smoothstep(12.0, 30.0, P.y - K.anchor.w + (bn - 0.5) * 8.0);
      mist = max(mist, smoothstep(0.54, 0.68, pn) * low * K.mpatch.y * smoothstep(near, near * 3.0, D));
    }
    mist = clamp(mist, 0.0, 1.0);
  }
  // mist eats the feet of every mass where the water or a much nearer form cuts it off below
  if (cls != C_SKY && cls != C_WATER && cls != C_WAVE && K.look3.w > 0.0 && !night) {
    let fn_ = lodNoise(P * vec3f(1.0, 1.5, 1.0) + 41.0, max(fp * 80.0 * uK, 1.0));
    let fw = K.look3.z * (0.45 + 1.1 * fn_) * mix(0.5, 1.0, smoothstep(near, far * 0.25, D));
    let foot = (1.0 - smoothstep(0.0, fw, RG.a)) * smoothstep(near * 1.2, near * 4.0, D) * K.look3.w;
    mist = max(mist, foot * select(1.0, 0.45, isArch(cls)));
  }
  // the woods dark at the shore and paling upward into the evening haze (world height, so it holds still)
  if (K.look6.z > 0.0 && (isFol(cls) || isLand(cls))) {
    let vn = lodNoise(P * vec3f(1.0, 2.0, 1.0) + 61.0, max(fp * 60.0 * uK, 1.0));
    mist = max(mist, K.look6.z * smoothstep(K.look6.x, K.look6.y, P.y + (vn - 0.5) * (K.look6.y - K.look6.x) * 0.8) * (1.0 - smoothstep(700.0, 1200.0, D)));
  }
  wash *= 1.0 - mist;
  // the wash is laid with a broad brush: horizontal sweeps, a little uneven (on water along the look's horizontal)
  var sweepW = lodNoise(P * vec3f(1.0, 5.0, 1.0) + 2.3, fp * 38.0 * uK);
  if (cls == C_SKY) { sweepW = 0.5; }
  else if (cls == C_WATER) { sweepW = lodNoise(vec3f(dot(P, camR) * 0.1, 0.0, dot(P, camF)) + 2.3, fp * 38.0 * uK); }
  wash *= select(0.82 + 0.36 * sweepW, 0.94 + 0.12 * sweepW, cls == C_ROOF || cls == C_CITYFAR || cls == C_WATER);
  // granulation: pigment settles into the paper texture
  wash *= 1.0 - K.st1.y * 0.5 + K.st1.y * grain;

  // ---------------- 皴 on hills and rock (in shade)
  var cunInk = 0.0;
  if (isLand(cls) && hasN && D < cunFar && (bench & 32u) == 0u && F_CUN) {
    let slope = 1.0 - Nw.y;
    var dens = K.st2.z * clamp(select(0.3, 0.05, cls == C_GROUND) + 0.5 * shade + 0.35 * w0, 0.0, 0.95) * idk;
    if (cls == C_GROUND) { dens *= smoothstep(0.15, 0.45, slope); }
    if (cls == C_ROCK) { dens = min(dens * 1.7, 0.95); }
    dens *= 1.0 - smoothstep(0.86, 0.97, tone);
    dens *= 1.0 - smoothstep(cunFar * 0.45, cunFar, D);
    let kind = select(0.0, 1.0, cls == C_ROCK || cls == C_FIGURE || K.st2.w > 0.5);
    if (dens > 0.01 && cls != C_FIGURE) { cunInk = cunStrokes(P, Nw, fp, dens, kind) * 0.85; }
    cunInk *= select(mix(1.0, 0.25, farK), 1.0 - farW, match_);
    if (cls == C_ROCK || cls == C_NICHE) { cunInk *= K.look2.x * select(1.0, 0.55, match_); }
  }

  // ---------------- grass: upright blades drawn with a dry brush (linan's grass has them from the photograph's own
  // blades, through the dark detail; Mo's grass is one tone), world-anchored on the plane facing the look
  if (cls == C_SMALL && hasN && !night) {
    let gq = vec2f(dot(P, camR), P.y);
    let gl = log2(fp * 7.0 * uK); let gl0 = floor(gl);
    let gd = clamp(0.4 + 0.45 * shade, 0.0, 0.85);
    let blades = mix(streakLevel(gq, normalize(vec2f(0.15, -1.0)), exp2(gl0), gd, 0.0, gl0 + 80.0),
                     streakLevel(gq, normalize(vec2f(0.15, -1.0)), exp2(gl0 + 1.0), gd, 0.0, gl0 + 81.0), smoothstep(0.0, 1.0, gl - gl0));
    // (the stills' tufts read as dense dry strokes, not pale clumps)
    cunInk = max(cunInk, blades * 0.7 * mix(0.5, 1.0, idk) * (1.0 - smoothstep(far * 0.1, far * 0.4, D)));
  }

  // ---------------- leaf marks by species, 米点 far away
  var leaf = 0.0; var treeTone = 1.0;
  var petal = 0.0; var thread = 0.0;   // (the flowers' and the willow threads' share of the marks: their colour)
  if (tree && (bench & 8u) == 0u && F_LEAF) {
    let O = Cw;
    let Do = length(Cr);
    let th = h13(vec3i(floor(O * 1.7)) + 91);
    treeTone = 0.7 + 0.6 * th;                       // 墨分五色: each tree its own tone
    let fpo = Do * pxA * uK;
    // (the tree's own frame: across the line of sight to its trunk, and up — a turn of the head does not change it)
    let tv = normalize(vec3f(-Cr.z, 0.0, Cr.x) + vec3f(1e-5, 0.0, 0.0));
    let lp = vec2f(dot(P - O, tv), P.y - O.y);
    var dens = K.st3.x * clamp(0.12 + 0.6 * shade + 0.45 * w0, 0.0, 0.95) * idk * idk;
    if (crownW >= 0.0) { dens = K.st3.x * clamp(0.3 + 0.4 * shade + 0.4 * clumpB, 0.0, 0.92) * mix(0.55, 1.0, clumpBody) * mix(0.6, 1.0, idk); }
    let mi = smoothstep(uMi * 0.8, uMi * 1.3, Do);
    var nearL = 0.0;
    let seed = floor(th * 997.0);
    if (mi < 0.999) {
      if (cls == C_PINE) { nearL = pineFans(lp, fpo * 21.0, fpo, clamp(0.1 + 0.8 * shade + 0.4 * w0, 0.0, 0.95) * K.st3.x * idk, seed) * select(1.0, 0.7 + 0.5 * clumpBody, crownW >= 0.0); }
      else if (cls == C_WILLOW && match_) {
        let sc = scaleOf(Cc.y);
        let fw = smoothstep(0.035, 0.1, fpo / max(sc, 0.3));
        var bg = boughs(lp, sc, fpo, seed, true);
        bg.x *= 1.0 - fw;
        let th = willowThreads(lp, sc, fpo, select(0.55 + 0.35 * shade, 0.85, paperLift > 0.5), seed);
        nearL = max(th * 0.55, bg.x * 0.95);
        thread = th * (1.0 - bg.x);
      }
      else if (cls == C_WILLOW) { nearL = willowStrands(lp, fpo * 16.0, fpo, select(dens * 0.55, 0.85, paperLift > 0.5), seed); }
      else if (cls == C_MAPLE || cls == C_GINKGO) { nearL = lobedLeaves(lp, fpo * 10.0, fpo, clamp(dens * 1.3 + 0.15, 0.0, 0.95), seed, select(3.0, 5.0, cls == C_MAPLE)); }
      else if (cls == C_BLOSSOM && match_) {
        // dark limbs and twigs, the flowers in small clusters along their outer halves (pink, in the colour below)
        let sc = scaleOf(Cc.y);
        let bg = boughs(lp, sc, fpo, seed, false);
        let near = 1.0 - smoothstep(0.25 * sc, 0.8 * sc, bg.y);
        let fl = leafDots(lp, max(fpo * 4.0, 0.07 * sc), fpo, 0.25 + 0.6 * near, seed, 0.0, 1.0) * (0.3 + 0.7 * near);
        petal = fl * (1.0 - bg.x);
        nearL = max(bg.x * 0.9, fl * 0.12);
      }
      else if (cls == C_BLOSSOM) { nearL = 0.6 * leafDots(lp, fpo * 7.0, fpo, 0.6, seed, 1.0, 1.0); }
      else { nearL = leafDots(lp, fpo * select(10.0, 5.5, crownW >= 0.0), fpo, dens, seed, 0.0, 1.5) * select(1.0, 0.55 + 0.45 * clumpB, crownW >= 0.0); }
    }
    var farL = 0.0;
    if (mi > 0.001) { farL = miDots(lp, fpo * 9.0, 0.85 * clamp(idk, 0.3, 1.0), seed); }
    leaf = mix(nearL, farL * select(0.6, 0.15, cls == C_BLOSSOM || cls == C_WILLOW), mi) * (1.0 - smoothstep(cunFar * 0.7, cunFar * 1.4, Do)) * K.look5.y;
  }

  // ---------------- tile rows: lines running down each roof plane, a row every ~0.3 m across the slope, doubled in
  // spacing as they get small on screen (no moiré), broken along their length
  var tiles = 0.0;
  if (cls == C_ROOF && match_ && hasN && !night) {
    let tA0 = cross(Nw, vec3f(0.0, 1.0, 0.0));
    if (dot(tA0, tA0) > 0.02) {
      let tA = normalize(tA0);
      let u = dot(P, tA);
      let px = max(fp * uK, 1e-4);
      let S = 0.3 * exp2(ceil(log2(max(3.2 * px / 0.3, 1.0))));
      let dl = abs(fract(u / S) - 0.5) * S / px;
      let along = dot(P, normalize(cross(tA, Nw)));
      let brk = smoothstep(0.3, 0.55, vnoise2(vec2f(floor(u / S) * 3.7, along / max(px * 25.0, 0.2))));
      tiles = smoothstep(0.35 + 0.7, 0.35 - 0.2, abs(dl - S / px * 0.5)) * brk * (0.55 + 0.45 * shade) * (1.0 - smoothstep(far * 0.15, far * 0.5, D)) * (1.0 - 0.85 * snowTop);
    }
  }
  // ---------------- lotus veins: 勾筋 radiating from the leaf centre, near leaves only
  var vein = 0.0;
  if (cls == C_LOTUS && hasN) {
    let O = Cw;
    let vv = P.xz - O.xz;
    let r = length(vv);
    let a = atan2(vv.y, vv.x) + h13(vec3i(floor(O * 3.1)) + 5) * 6.28;
    let dA = abs(fract(a / 6.2831 * 13.0 + 0.5) - 0.5) / 13.0 * 6.2831;
    let px = fp * uK;
    vein = smoothstep(px * 1.1, px * 0.3, r * sin(dA)) * smoothstep(px * 4.0, px * 10.0, r) * (1.0 - smoothstep(near * 0.8, near * 2.5, D));
    vein *= select(0.55, 0.3, match_) * smoothstep(0.3, 0.55, lodNoise(P + 4.4, fp * 25.0 * uK));
  }
  // ---------------- water: blank paper with sparse ripple lines (水纹 rows where the look asks for them)
  var wave = 0.0;
  if (cls == C_WATER && F_WATER) {
    let sinG = clamp((F.eye.y - P.y) / max(D, 1.0), 0.004, 1.0);
    let sinW = mix(clamp((K.anchor.y - P.y) / max(length(P - K.anchor.xyz), 1.0), 0.004, 1.0), K.axisR.w, K.axisF.w);
    let dens = clamp(K.sh2.z * K.st3.z, 0.0, 1.0);
    if (K.sh2.w > 0.5) { wave = waveRows(P, fp, sinG, sinW, dens, 0.45, 9.0) * 0.8; }
    else { wave = ripples(P, fp, dens, sinG, sinW); }
    wave *= 1.0 - smoothstep(far * 0.35, far * 1.1, D);
    // about the painted bore the river churns (ink09): a grey wash broken by rows of white crests (paper) with dark
    // troughs under them, calming with distance from the front; the churned rows spread far behind the wall and the
    // spent foam runs on ahead of its foot toward the bank, in the front's own frame, scaled by the wall's height
    if (K.bore0.x != 0.0 && match_) {
      let BF = boreFrame(P);
      let kk = max(BF.z / 14.0, 0.5);
      let al = BF.x; let sd = -BF.y;                                 // sd: + behind the front (away from the camera)
      let bl = length(K.bore0.zw - K.bore0.xy);
      let inside = smoothstep(-20.0, 10.0, al) * (1.0 - smoothstep(bl - 10.0, bl + 30.0, al));
      let churnB = smoothstep(-4.0, 6.0, sd) * (0.35 + 0.65 * exp(-max(sd, 0.0) / (60.0 * kk))) * (1.0 - smoothstep(200.0 * kk, 420.0 * kk, sd));
      let churnA = step(sd, 0.0) * (1.0 - smoothstep(40.0 * kk, 150.0 * kk, -sd)) * 0.8;
      let churn = max(churnB, churnA) * inside;
      if (churn > 0.001) {
        let q2 = vec2f(al, sd);
        let sinW2 = clamp((K.anchor.y - P.y) / max(length(P - K.anchor.xyz), 1.0), 0.004, 1.0);
        let pxPerV = sinG / max(fp, 1e-5);
        let l = log2(16.0 * uK / pxPerV); let l0 = floor(l); let tt = smoothstep(0.0, 1.0, l - l0);
        var crest = 0.0; var trough = 0.0;
        for (var L = 0; L < 2; L++) {
          // one breaking crest per cell of a staggered world lattice: an arc of random width and offset, white on its
          // top edge, a dark trough in its lee (toward the viewer), the rest of the cell the churned grey
          let lev = l0 + f32(L);
          let wl = select(tt, 1.0 - tt, L == 0);
          if (wl < 0.01) { continue; }
          let Sv = exp2(lev); let Su = Sv * 3.6 * max(sinW2, 0.03);
          let g = vec2f(q2.x / Su, q2.y / Sv); let gi = floor(g);
          var c0 = 0.0; var t0 = 0.0;
          for (var j = -1; j <= 1; j++) {
            for (var i = -1; i <= 1; i++) {
              let cid = gi + vec2f(f32(i), f32(j));
              let h = h43(vec3i(vec2i(cid), i32(lev) * 7 + 811));
              if (h.w < 0.2) { continue; }
              let cc = (cid + vec2f(0.5 * fmodp(cid.y, 2.0) + h.x * 0.6, 0.3 + 0.4 * h.y)) * vec2f(Su, Sv);
              let vv = (q2 - cc) / vec2f(Su * (0.35 + 0.4 * h.z), Sv);
              if (abs(vv.x) > 1.0) { continue; }
              let taper = 1.0 - vv.x * vv.x;
              let dy = vv.y - 0.35 * taper;                         // + behind (far side), − toward the viewer
              c0 = max(c0, smoothstep(0.2 * taper, 0.0, abs(dy + 0.05)) * taper);
              t0 = max(t0, smoothstep(-0.05, -0.18, dy) * (1.0 - smoothstep(-0.35, -0.6, dy)) * taper);
            }
          }
          crest += c0 * wl; trough += t0 * wl;
        }
        // the spent foam ahead: long streaks of white along the front on a paler grey, fewer dark troughs
        let ahead = step(sd, 0.0);
        let streak = smoothstep(0.55, 0.8, lodNoise(vec3f(al * 0.06, 0.0, sd * 0.6) + 3.1, max(fp * 6.0 * uK / max(sinW2, 0.05), 0.4))) * ahead;
        let g0 = mix(0.24 + 0.3 * trough, 0.2 + 0.12 * trough, ahead) * (0.75 + 0.35 * exp(-abs(sd) / (50.0 * kk)));
        wash = mix(wash, g0 * (1.0 - 0.85 * max(crest, streak * 0.8)) * inkGain * (1.0 - mist), churn);
        wave *= 1.0 - churn;
      }
      // white water at the foot of the face (under its apron): the wash lifts to paper
      let foam = (1.0 - smoothstep(0.0, 22.0 * kk, -sd)) * step(sd, 0.0) * inside;
      wash *= 1.0 - 0.8 * foam; wave *= 1.0 - foam;
    }
    if (K.sh2.w < 0.5) { wave *= exp(-RG.b / 28.0); }
    else { wave *= max(smoothstep(0.15, 0.8, fK), exp(-RG.b / 10.0)); }
  }
  if (cls == C_WAVE && match_ && K.bore0.x != 0.0) {
    // ink09, after 李嵩《钱塘观潮图》 / 马远《水图》: the painted bore as a breaking wall, painted in the front's own
    // frame (m along it, m ahead of the crest, the local height): the foam left as paper; the face a grey wash
    // deepening up into the hollow under each curling lip, cut by streaks of foam pouring down it and crossed by fine
    // lines running along the wall (水纹); the curl's underside a dark hook; dry streaks of spray rising up and back off
    // the crest; the white water spread at the foot; the raised churned water behind the crest a light grey
    let BF = boreFrame(P);
    let H = max(BF.z, 1.0); let kk = H / 16.0;
    let yr = P.y / H;                                     // height on the wall (1 = the crest)
    let fw = BF.y / kk;                                   // ahead of the crest line in profile units (the face 3–10)
    let toV = dot(Nw.xz, boreN());                        // the surface turned toward the viewer's side (the face)
    // (the painter's light leads: the foam stays paper in a hill's cast shadow)
    let lt = mix(mix(plB, LL.y, 0.4), smoothstep(0.05, 0.65, sunF), 0.15);
    let shK = 1.0 - smoothstep(0.3, 0.85, lt);
    let under = smoothstep(-0.05, -0.5, Nw.y);            // the curl's underside
    let apron = (1.0 - smoothstep(0.07, 0.17, yr)) * smoothstep(8.0, 11.0, fw);
    let faceK = smoothstep(0.1, 0.45, toV) * (1.0 - apron) * (1.0 - smoothstep(0.86, 0.97, yr));
    let back = smoothstep(2.5, -3.0, fw) * smoothstep(-0.2, 0.3, Nw.y);
    let spray = smoothstep(0.98, 1.12, yr);
    let fq = vec2f(BF.x, P.y);                            // the front's plane: m along it, m up
    let px = max(fp * uK, 1e-4);
    let l = log2(px * 30.0); let l0 = floor(l); let lt2 = smoothstep(0.0, 1.0, l - l0);
    let pd = clamp(0.4 + 0.35 * (1.0 - yr), 0.0, 0.9);
    let pour = mix(streakLevel(fq, vec2f(0.0, -1.0), exp2(l0), pd, 1.0, l0 + 60.0), streakLevel(fq, vec2f(0.0, -1.0), exp2(l0 + 1.0), pd, 1.0, l0 + 61.0), lt2);
    // the face: under a full curl the hollow under the lip is the darkest grey, the face below it grey cut by white
    // streaks of foam pouring down; where the crest spills the whole face is white foam streaked with grey; the trough
    // at its foot a grey band where it rises from the water
    let ck = BF.w;
    let hollow = smoothstep(0.42, 0.74, yr) * (1.0 - smoothstep(0.84, 0.93, yr));
    let trough = 1.0 - smoothstep(0.02, 0.22, yr);
    let curlW = (mix(0.16, 0.48, hollow) * (1.0 - 0.8 * pour) + 0.1 * trough) * (0.85 + 0.25 * shK);
    let spillW = 0.04 + 0.2 * pour * (1.0 - trough) + 0.16 * trough + 0.06 * shK;
    var w = mix(spillW, curlW, smoothstep(0.25, 0.75, ck)) * faceK;
    w = max(w, (0.3 + 0.25 * shK) * (0.4 + 0.6 * ck) * under * (1.0 - spray));
    let top = (1.0 - faceK) * (1.0 - under) * (1.0 - apron) * (1.0 - back);
    // (the foam's folds: a soft grey where a lump turns from the light, world-anchored mottling, no outlines)
    let fold = lodNoise(P * vec3f(1.0, 1.4, 1.0) + 13.0, max(px * 25.0, 0.3));
    w = max(w, top * (0.02 + 0.2 * shK * shK + 0.06 * smoothstep(0.5, 0.8, fold)));
    w = max(w, back * (1.0 - spray) * (0.13 + 0.08 * shK) * (1.0 - 0.7 * pour));
    let apS = smoothstep(0.5, 0.8, lodNoise(vec3f(BF.x * 0.08, 0.0, BF.y * 0.5) + 5.0, max(px * 8.0, 0.3)));
    w = mix(w, 0.04 + 0.12 * apS, apron);
    wash = w * inkGain;
    // lines along the face: rows of constant height on the wall, waving gently along it, broken where the brush lifts
    let gL = yr * 3.5 + 0.45 * sin(BF.x / (H * 0.8) + 1.3) + 0.25 * sin(BF.x / (H * 0.33));
    let dL = abs(gL - floor(gL + 0.5)) * (H / 3.5) / px;
    let lineF = smoothstep(0.9, 0.3, dL) * smoothstep(0.5, 0.68, lodNoise(vec3f(BF.x * 0.3, P.y * 2.0, 0.0) + 7.0, max(px * 30.0, 0.5))) * step(0.15, yr) * step(yr, 0.82);
    // spray: dry streaks rising up and back off the crest, thinning into the sky
    let sl = log2(px * 22.0); let sl0 = floor(sl);
    let sdens = clamp(0.15 + 0.35 * shK, 0.0, 0.7) * max(top, spray * 0.8) * (1.0 - smoothstep(1.15, 1.4, yr));
    let sd2 = normalize(vec2f(0.55, 1.0));
    let sst = mix(streakLevel(fq, sd2, exp2(sl0), sdens, 1.0, sl0 + 70.0), streakLevel(fq, sd2, exp2(sl0 + 1.0), sdens, 1.0, sl0 + 71.0), smoothstep(0.0, 1.0, sl - sl0));
    // the spray's torn top edge: the streaks and the grey thin out into paper toward it (no hard rim)
    let rimT = smoothstep(0.0, 7.0, RG.r);
    wash *= mix(1.0, rimT, spray);
    wave = lineF * faceK * 0.6 + sst * 0.4 * mix(1.0, rimT, spray);
  }

  // ---------------- brush lines (the nearest seed of the jump flood: its strength, width, direction and type)
  var lineInk = 0.0; var bleed = 0.0;
  let J = textureLoad(tJfa, gp, 0);
  if (J.w != 0u && (bench & 1u) == 0u && F_LINES) { let bl = brushLine(J, fc, idk, fK, grain); lineInk = bl.x; bleed = bl.y; }
  // ---------------- 苔点: moss dots on the ridge tops of near hills and rocks
  var moss = 0.0;
  if (K.st3.y > 0.0 && J.w != 0u) {
    let sp = vec2i(i32(J.x & 0xffffu), i32(J.x >> 16u));
    let SA = texA(sp);
    let sc = clsOf(SA);
    let up = texA(sp - vec2i(0, i32(4.0)));
    let ridgeTop = clsOf(up) == C_SKY || depthOf(up) > depthOf(SA) * 1.15;
    if (isLand(sc) && ridgeTop && depthOf(SA) < cunFar * 0.5) {
      let sOut = vec2f(sp) + 0.5;
      let Ps = relPosOf(sOut / K.res.xy, depthOf(SA)) + F.eye.xyz;
      let fps = depthOf(SA) * pxA * uK;
      let qq = vec2f(dot(Ps, camR), Ps.y) + vec2f(0.0, (sOut.y - fc.y) * fps);
      let dd = length(fc - sOut);
      moss = leafDots(qq, fps * 12.0, fps, 0.45 * K.st3.y, 77.0, 0.0, 1.35) * smoothstep(7.0 * uK, 3.0 * uK, dd);
      moss *= smoothstep(0.45, 0.6, lodNoise(Ps, fps * 60.0)) * idk;
    }
  }

  // ---------------- colour
  let lit = clamp(sunF, 0.0, 1.0);
  leaf *= 1.0 - select(0.75 * farK, select(0.8, 0.35, paperLift > 0.5) * farW, match_);
  var ink = wash + cunInk * 0.9 + (leaf + moss) * treeTone * 0.95 + wave * 0.6 + lineInk * 1.5 + bleed + facetLine * 0.7 + vein + tiles * 0.3;
  let snowK = select(0.0, smoothstep(0.68, 0.8, max(tone, tB)), paperLift > 0.0 && (isLand(cls) || isArch(cls) || isFol(cls)));
  var absP = vec3f(0.0);
  // 纯水墨 with a touch of colour: pink blossom and lotus, red maple, gold ginkgo, the sky's own warmth
  if (K.look.w > 0.0) {
    var acc = vec3f(0.0);
    if (cls == C_BLOSSOM) { acc = (P_ZHU * 0.42 + P_ZHE * 0.04) * select(1.0, 0.05 + 0.85 * petal, match_); }
    else if (cls == C_WILLOW && match_) { acc = (P_TENG * 0.35 + P_ZHE * 0.3) * thread; }
    else if (cls == C_MAPLE) { acc = P_ZHU * (1.0 + 0.4 * lit) + P_ZHE * 0.3; }
    else if (cls == C_GINKGO) { acc = P_TENG * 0.9 + P_ZHE * 0.35; }
    else if (cls == C_IVY) { acc = (P_TENG * 0.6 + P_ZHE * 0.5) * 0.45; }
    else if (cls == C_BLOOM) { acc = P_ZHU * (0.03 + 0.34 * 0.5); }
    else if (cls == C_SKY && !night) {
      let hz = 1.0 - smoothstep(0.0, 0.35, dirW.y);
      let toSun = pow(max(dot(dirW, F.sun.xyz), 0.0), 6.0);
      acc = (P_ZHE * 0.3 * (0.3 + 0.7 * toSun) + P_TENG * 0.25 * toSun) * K.sh3.x * hz;
    }
    absP += acc * K.look.w * (1.0 - snowK);
  }
  // the sun's glow: pale gold round the sun, gold on its path on the water, the forms against the sun catching it
  if (K.look5.x > 0.0 && !night) {
    if (cls == C_SKY) { absP += (P_TENG * 0.17 + P_ZHE * 0.17) * glowW * (1.0 - 0.8 * exp(-sunAng / 0.012)) + (P_ZHE * 0.05 + P_INK * 0.03) * (1.0 - clamp(glowW * 1.5, 0.0, 1.0)); }
    else if (cls == C_WATER) { absP += (P_TENG * 0.1 + P_ZHE * 0.05) * sunPath * K.look5.x; }
    else { absP += (P_TENG * 0.1 + P_ZHE * 0.05) * glowS; }
  }
  if (cls == C_SKY && K.skyTint.w > 0.0) {
    // a blue (or warm) sky, deeper toward the zenith; the clouds stay paper
    let up = smoothstep(0.0, 0.45, dirW.y);
    absP += K.skyTint.rgb * K.skyTint.w * (0.25 + 0.75 * up) * select((1.0 - cl.x) * (1.0 - 0.6 * RNG.x), 1.0 - smoothstep(0.42, 0.55, tS), night);
  }
  if (night && K.skyTint.w > 0.0 && cls != C_GLOW) { absP += K.skyTint.rgb * K.skyTint.w * 0.35 * (1.0 - smoothstep(0.42, 0.55, tS)); }
  var col = paper * exp(-absP * (1.0 - mist));
  // dark detail: what the G-buffer has darker than a ring of its neighbours (tile rows, lattices, joints, bark, the
  // leaf clusters), drawn as fine ink — the painters' 細筆 inside the washes
  var detK = 0.0;
  if ((K.look.x > 0.0 || cls == C_PAVE) && cls != C_SKY && cls != C_WATER && cls != C_WAVE && cls != C_BLOOM && !night && (bench & 2u) == 0u && F_DETAIL) {
    let fineK = isArch(cls) || cls == C_GROUND || cls == C_SMALL || cls == C_PAVE;
    let rr = select(4.0, 2.5, fineK) * uK;
    let c0 = select(gShade(gp), gAlb(gp), gLift);
    var sm = 0.0; var sn = 0.0;
    // (grass against its own kind only: Mo's tufts are darker than its plain ground, where linan's photograph has pale
    // tufts on dark earth, and the ring would outline every tuft)
    let own = cls == C_SMALL;
    for (var i = 0; i < 6; i++) {
      let a = f32(i) * 1.0472 + 0.3;
      let o = vec2i(round(vec2f(cos(a), sin(a)) * rr));
      if (own && clsOf(texA(gp + o)) != C_SMALL) { continue; }
      let vv = select(gShade(gp + o), gAlb(gp + o), gLift);
      if (vv >= 0.0) { sm += vv; sn += 1.0; }
    }
    let hp = select(0.0, (sm / sn - c0) / (sm / sn + 0.04) * 0.25, sn > 0.0 && c0 >= 0.0);
    var kk = 0.4;
    if (cls == C_PAVE) { kk = 0.35; } else if (cls == C_ROOF || cls == C_CITYFAR) { kk = select(0.75, 0.15, match_); }
    else if (isArch(cls)) { kk = 1.0; } else if (isTree(cls)) { kk = select(0.8, 0.12, match_); } else if (cls == C_LOTUS) { kk = 0.15; }
    else if (cls == C_ROCK || cls == C_NICHE) { kk = select(0.5, 0.12, match_) * K.look2.x; } else if (cls == C_FIGURE) { kk = select(0.4, 0.2, match_); }
    else if (cls == C_GROUND) { kk = 0.6; }
    let lo = select(select(0.015, 0.005, fineK), select(0.03, 0.06, cls == C_PAVE), cls == C_GROUND || cls == C_PAVE);
    var det = 1.25 * clamp((hp - lo) / select(0.2, 0.16, fineK), 0.0, 0.8) * kk * select(K.look.x, 1.0, cls == C_PAVE) * mix(0.55, 1.0, idk) * mix(1.0, 0.3, smoothstep(far * 0.3, far, D));
    det *= 1.0 - farW;
    if (gLift && cls != C_PAVE) { det *= 1.0 - 0.85 * K.look5.w; }
    if (K.look5.z > 0.0 && cls == C_STONE && hasN && abs(Nw.y) < 0.6) { det *= 1.0 - 0.9 * K.look5.z; }
    ink += det * (1.0 - max(snowK * 0.7, snowTop * 0.85));
    detK = det;
  }
  // the slab joints Mo's G-buffer draws on a paved path (linan's come from the photograph's own slabs)
  if (cls == C_PAVE) {
    // (soft and broken: the stills' slab joints are a breath of grey, not a ruled grid)
    let jb = smoothstep(0.3, 0.7, lodNoise(P + 3.1, fp * 14.0 * uK));
    ink = max(ink, bitcast<f32>(Cc.z) * select(0.32, 0.5, match_) * (0.4 + 0.6 * jb));
  }
  // the battered stone walls of the terraces: a pale wash, deeper toward the foot and in a few damp vertical streaks,
  // the courses only hinted
  if (K.look5.z > 0.0 && cls == C_STONE && hasN && abs(Nw.y) < 0.6 && !night) {
    let tW = normalize(cross(Nw, vec3f(0.0, 1.0, 0.0)) + 1e-5);
    let along = dot(P, tW); let px = max(fp * uK, 1e-4);
    let cs = 0.85 * exp2(max(0.0, ceil(log2(4.0 * px / 0.85))));
    let dl = abs(fract(P.y / cs + 0.5) - 0.5) * cs / px;
    let patchC = smoothstep(0.58, 0.74, lodNoise(vec3f(along, P.y * 1.6, 0.0) + 7.0, max(cs * 9.0, px * 40.0)));
    let brk = smoothstep(0.35, 0.6, vnoise2(vec2f(along / max(cs * 3.0, px * 12.0), floor(P.y / cs) * 1.7)));
    let course = smoothstep(1.0, 0.25, dl) * patchC * brk;
    let streak = smoothstep(0.55, 0.8, lodNoise(vec3f(along * 1.0, P.y * 0.12, 3.0) + 19.0, max(px * 30.0, 1.5)));
    let foot = 1.0 - smoothstep(0.0, 140.0, RG.g);
    ink += K.look5.z * ((0.05 + 0.08 * shade) * (0.5 + 0.8 * foot) + 0.06 * streak + 0.22 * course) * mix(0.6, 1.0, idk);
  }
  // a willow's crown hangs: its lower part opens into strands, the gaps between them painted as what lies behind —
  // the paper by day, the night sky's wash at night (world-anchored vertical gaps, a few pixels apart at any distance,
  // denser toward the hem; the low-poly hull read as one solid lobed blob)
  if (cls == C_WILLOW && match_ && hasN) {
    let h = P.y - Cw.y;
    let hem = 1.0 - smoothstep(3.2, 6.2, h);
    // (the spacing in power-of-two levels blended by distance: a scale that follows the distance continuously would
    // make the gaps crawl as the eye walks)
    let sn = lodNoise(vec3f(P.x, P.y * 0.1, P.z) + vec3f(1.3, 7.1, 4.4), max(0.18, fp * uK * 3.0));
    let gap = smoothstep(0.55 * hem, 0.55 * hem - 0.06, sn) * step(1.0, h) * step(0.001, hem);
    if (gap > 0.0) {
      let behind = select(0.0, (0.52 + 0.22 * smoothstep(0.0, 0.45, dirW.y)) * K.sh2.x, night);
      ink = mix(ink, behind, gap);
    }
  }
  // haze: beyond the haze distance everything fades toward the paper
  if (K.look2.w > 0.0 && cls != C_SKY) { ink *= 1.0 - 0.8 * smoothstep(K.look2.w, K.look2.w * 2.5, D); }
  ink *= 1.0 - mist;
  if (cls != C_SKY && cls != C_WATER) { ink *= 1.0 - 0.6 * clamp(glowS, 0.0, 1.0); }   // backlit forms veiled by the glow
  col *= exp(-K.inkAbs.rgb * K.tint.rgb * ink * 2.4);
  // the low sun itself, the brightest thing in the painting, where the sky shows it
  if (K.look5.x > 0.0 && !night) { col = mix(col, vec3f(1.0, 0.985, 0.94), K.look5.x * exp(-sunAng / 0.012) * select(0.35, 0.9, cls == C_SKY)); }
  // a lantern's opening keeps its light at night
  if (night && cls == C_GLOW) { col = mix(col, vec3f(1.0, 0.9, 0.62), 0.85); }
  // fallen petals on the ground in spring (Mo's): pale pink specks in drifts
  if ((cls == C_GROUND || cls == C_PAVE) && F.season.x > 0.0) {
    let cell = floor(P.xz / 0.12);
    let h = h43(vec3i(vec2i(cell), 57));
    let drift = smoothstep(0.35, 0.75, vnoise2(P.xz / 6.0 + 1.7)) * select(1.0, 0.35, cls == C_PAVE);
    let on = markOn(h.x, 0.5 * drift * F.season.x);
    let c = (cell + 0.15 + 0.7 * h.yz) * 0.12;
    let r = 0.016 + 0.012 * h.w;
    let dd = length(P.xz - c);
    let nearP = 1.0 - smoothstep(r * 0.6, r * 1.6, fp);
    let speck = (1.0 - smoothstep(r - fp * 0.7, r + fp * 0.7, dd)) * on * nearP;
    col = mix(col, F.season.yzw, clamp(speck * 0.75 + 0.12 * drift * F.season.x * (1.0 - nearP), 0.0, 1.0) * (1.0 - mist));
  }
  let dbg = u32(K.inkAbs.w + 0.5);
  if (dbg == 1u) { return vec4f(wash, detK, mist, 1.0); }
  if (dbg == 2u) { return vec4f(tone, tB, cunInk, 1.0); }
  if (dbg == 3u) { return vec4f(idk, fK, cunInk, 1.0); }
  if (dbg == 4u) { return vec4f(lineInk + bleed, leaf, cunInk, 1.0); }
  if (dbg == 5u) { return vec4f(clamp(RG.r / 40.0, 0.0, 1.0), clamp(RG.g / 150.0, 0.0, 1.0), clamp(RG.a / 100.0, 0.0, 1.0), 1.0); }
  if (dbg == 6u || dbg == 9u) { return vec4f(tS, tF, tB, 1.0); }
  if (dbg == 7u) { return vec4f(B.x, B.y, B.z, 1.0); }
  if (dbg == 8u) { return vec4f(f32(cls) / 32.0, clamp(D / 2000.0, 0.0, 1.0), 0.0, 1.0); }
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
