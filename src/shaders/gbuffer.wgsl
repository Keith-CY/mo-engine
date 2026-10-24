// The G-buffer: every visible instance once, three colour targets and reverse-Z depth.
//   A  view normal (octahedral, 2) · view depth (m) · class id
//   B  sun light (N·L × shadow) · sky light · albedo luminance · the cast shadow alone (1 lit)
//   C  object seed · instance id · joints drawn on the surface (0 … 1, f32 bits) · its block's own tone (0 … 1, −1 none;
//      f32 bits)
struct Draw {
  visibleBase: u32,
  cls: u32,       // the mesh's class (an instance may override it)
  tone: f32,      // the mesh's albedo luminance when it has none per vertex
  hasTone: u32,
  level: u32,     // the LOD level this draw holds
  cutoff: f32,    // alpha cutoff of its alpha-tested triangles
  lift: f32,      // metres of lift per metre of eye distance (ground covers over the coarse far terrain)
  billboard: u32, // a far impostor's silhouette + 1 (0: an ordinary mesh)
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d_array;
@group(0) @binding(2) var shadowCmp: sampler_comparison;
@group(0) @binding(3) var alphaTex: texture_2d<f32>;
@group(0) @binding(4) var alphaSamp: sampler;
@group(0) @binding(5) var paveMap: texture_2d<f32>;    // 1 on paving, bilinear between the field's samples
// the slab paths: [0].x their count; per path 9 vec4: (points, half width, slab length, crown height), then its points
// (x, z, arc length at the point, 0)
@group(0) @binding(6) var<storage, read> paths: array<vec4f>;
@group(0) @binding(7) var nearField: texture_2d<f32>;
@group(0) @binding(8) var farField: texture_2d<f32>;

fn hash11(x: f32) -> f32 { return hash3(vec3i(bitcast<i32>(x), 101, 7)); }

/** coursed blocks (after linan's brCourses): rows `size.y` high, some split into two thin ones, blocks about `size.x`
 *  long, the length varied per row and the rows offset → (distance to the vertical joint, to the bed joint, in uv
 *  units; the block's hash; the row's height in uv units) */
fn courses(uv: vec2f, size: vec2f) -> vec4f {
  let q = uv / size;
  var row = floor(q.y);
  var fy = fract(q.y);
  var rh = size.y;
  if (hash11(row * 1.91 + 0.7) > 0.78) { let sub = step(0.5, fy); fy = fract(fy * 2.0); row = row * 2.0 + sub + 1000.0; rh = size.y * 0.5; }
  let rl = 0.65 + 0.75 * hash11(row * 3.7 + 1.3);
  let qx = q.x / rl + hash11(row * 7.1 + 0.3);
  let col = floor(qx);
  return vec4f((0.5 - abs(fract(qx) - 0.5)) * size.x * rl, (0.5 - abs(fy - 0.5)) * rh, hash3(vec3i(i32(col), i32(row), 29)), rh);
}

/** the slab path at a ground point: (1 when paved, along it in slab lengths, across it 0 … 1) */
fn pathAt(xz: vec2f, y: f32) -> vec3f {
  let n = min(u32(paths[0].x), 4u);
  var out = vec3f(0.0);
  for (var k = 0u; k < n; k++) {
    let h = paths[1u + k * 9u];
    let np = min(u32(h.x), 8u);
    var best = 1e10; var s = 0.0; var sd = 0.0;
    for (var j = 0u; j + 1u < np; j++) {
      let a = paths[2u + k * 9u + j]; let b = paths[3u + k * 9u + j];
      let e = b.xy - a.xy; let len = max(length(e), 1e-3); let w = xz - a.xy;
      let t = clamp(dot(w, e) / (len * len), 0.0, 1.0);
      let d = length(w - e * t);
      if (d < best) { best = d; s = a.z + t * len; sd = sign(e.x * w.y - e.y * w.x) * d; }
    }
    // (the edge wanders a little, as the terrain shader's does)
    let edge = best - h.y + 0.12 * (vnoise(vec3f(s * 0.7, 3.0, 0.0)) - 0.5);
    if (edge < 0.0 && y > h.w) { out = vec3f(1.0, s / h.z, clamp((sd + h.y) / (2.0 * h.y), 0.0, 1.0)); }
  }
  return out;
}
/** a far impostor's silhouette at the card's own (u −1 … 1, v 0 … 1), per tree seed: (inside, the darker rim) — linan's
 *  BB_SHAPE: 0 dome on a short trunk, 1 pine (flat tiers on a leaning trunk), 2 willow (head and hanging curtain),
 *  3 small round head, 4 ovoid */
fn billboardShape(shape: u32, q: vec2f, seed: f32) -> vec2f {
  let u = q.x; let v = q.y;
  let n = vnoise(vec3f(u * 3.1, v * 3.4, seed * 37.0));
  let n2 = vnoise(vec3f(u * 9.0, v * 9.0, seed * 11.0));
  var a = 0.0; var dark = 0.0;
  if (shape == 0u) {
    let d = length(vec2f(u, (v - 0.6) / 0.42));
    let e = 0.9 + 0.3 * (n - 0.5) + 0.12 * (n2 - 0.5);
    a = max(step(d, e), step(abs(u), 0.06) * step(v, 0.3));
    dark = smoothstep(e - 0.25, e, d);
  } else if (shape == 1u) {
    let lean = (seed - 0.5) * 0.3 * v;
    let t1 = length(vec2f(u - lean, (v - 0.86) / 0.12));
    let t2 = length(vec2f((u - lean - 0.25 * (seed - 0.5)) / 0.8, (v - 0.66) / 0.1));
    let t3 = length(vec2f((u - lean + 0.3 * (seed - 0.4)) / 0.55, (v - 0.5) / 0.08));
    let e = 0.92 + 0.35 * (n - 0.5) + 0.15 * (n2 - 0.5);
    let d = min(t1, min(t2, t3));
    a = max(step(d, e), step(abs(u - lean), 0.045) * step(v, 0.8));
    dark = smoothstep(e - 0.3, e, d);
  } else if (shape == 2u) {
    let d = length(vec2f(u, (v - 0.68) / 0.36));
    let hem = 0.12 + 0.18 * vnoise(vec3f(u * 7.0 + seed * 9.0, 0.0, 0.5)) + 0.08 * (1.0 - abs(u));
    let curtain = step(abs(u), 0.88 + 0.1 * (n - 0.5)) * step(hem, v) * step(v, 0.8);
    let e = 0.92 + 0.25 * (n - 0.5);
    a = max(max(step(d, e), curtain * step(0.32, n2 + 0.2)), step(abs(u), 0.07) * step(v, 0.4));
    dark = smoothstep(0.6, 0.15, v) * 0.6;
  } else if (shape == 3u) {
    let d = length(vec2f(u, (v - 0.58) / 0.45));
    let e = 0.88 + 0.35 * (n - 0.5) + 0.2 * (n2 - 0.5);
    a = max(step(d, e), step(abs(u), 0.05) * step(v, 0.25));
    dark = smoothstep(e - 0.25, e, d);
  } else {
    let d = length(vec2f(u / 0.78, (v - 0.56) / 0.46));
    let e = 0.9 + 0.3 * (n - 0.5) + 0.2 * (n2 - 0.5);
    a = max(step(d, e), step(abs(u), 0.05) * step(v, 0.2));
    dark = smoothstep(e - 0.25, e, d);
  }
  return vec2f(a, dark);
}
@group(1) @binding(0) var<storage, read> inst: array<u32>;
@group(1) @binding(1) var<storage, read> visible: array<u32>;
@group(1) @binding(2) var<storage, read> lodState: array<u32>;
@group(2) @binding(0) var<uniform> D: Draw;

/** a surface point for the world's surface functions (src/shaders/surfaces.wgsl) */
struct Surface {
  kind: u32,      // the world's surface kind (paint.x)
  uv: vec2f,      // the metric surface coordinates
  paint: vec3f,   // the world's per-vertex paint values (y, z, w)
  P: vec3f,       // the world point
  N: vec3f,       // the world normal
  O: vec3f,       // the object's origin
  seed: f32,      // the object's seed, 0 … 1
  tone: f32,      // the measured albedo luminance (the fallback)
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) nW: vec3f,
  @location(1) depth: f32,
  @location(2) tone: f32,
  @location(3) @interpolate(flat) cls: u32,
  @location(4) @interpolate(flat) seed: u32,
  @location(5) @interpolate(flat) id: u32,
  @location(6) rel: vec3f,
  // dissolving between levels: how far (0 … 1), and whether this draw is the level coming (1) or going (−1)
  @location(7) @interpolate(flat) fade: vec2f,
  @location(8) uv: vec2f,
  // bit 0 alpha-tested, bit 1 terrain paving from the paths, bits 8–15 the surface pattern, 16–31 the world's surface kind
  @location(9) @interpolate(flat) flags: u32,
  @location(10) paint: vec3f,
  @location(11) @interpolate(flat) tmul: f32,
  @location(12) @interpolate(flat) origin: vec3f,
};

fn col(i: u32, c: u32) -> vec3f {
  let b = i * 16u + c * 3u;
  return vec3f(bitcast<f32>(inst[b]), bitcast<f32>(inst[b + 1u]), bitcast<f32>(inst[b + 2u]));
}

@vertex
fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) tone: f32, @location(3) uv: vec2f, @location(4) vcls: u32,
      @location(5) pw: vec2u, @builtin(instance_index) ii: u32) -> VOut {
  let i = visible[D.visibleBase + ii];
  let X = col(i, 0u); let Y = col(i, 1u); let Z = col(i, 2u); let T = col(i, 3u);
  var rel = X * p.x + Y * p.y + Z * p.z + (T - F.eye.xyz);
  var o: VOut;
  // (uniformly scaled instances: the normal goes through the same axes; the scenes keep scale near uniform)
  o.nW = X * n.x + Y * n.y + Z * n.z;
  if (D.billboard != 0u) {
    // a far impostor: the card turned about the instance's up toward the eye (where the eye is, not where it looks:
    // a turn of the head leaves it be), lit as a rounded crown (linan's far LOD: src/vegetation/materials.js BB_VERT)
    var d2 = F.eye.xz - T.xz;
    d2 = select(vec2f(0.0, 1.0), normalize(d2), dot(d2, d2) > 1e-8);
    let right = vec3f(d2.y, 0.0, -d2.x);
    rel = Y * p.y + right * p.x * length(X) + (T - F.eye.xyz);
    o.nW = normalize(right * uv.x * 0.85 + vec3f(0.0, 0.25 + 1.1 * (uv.y - 0.62), 0.0) + vec3f(d2.x, 0.0, d2.y) * 0.55);
  }
  // terrain: the grid lifted onto its field (src/shaders/terrain.wgsl)
  if ((vcls & VC_TERRAIN) != 0u) { let L = liftTerrain(rel, vcls, uv.x, length(X)); rel = L.rel; o.nW = L.nW; }
  rel.y += D.lift * length(rel);
  o.pos = F.viewProj * vec4f(rel, 1.0);
  o.rel = rel;
  o.depth = -(F.viewRot * vec4f(rel, 1.0)).z;
  // the class: the instance's, else the triangle's own (the vertex's class word), else the mesh's
  let ic = inst[i * 16u + 12u];
  let vc = vcls & 0xffffu;
  o.cls = select(ic, select(vc, D.cls, vc == 0xffffu), ic == 0xffffffffu);
  o.uv = uv;
  o.flags = ((vcls >> 16u) & 1u) | (((vcls >> 17u) & 1u) << 1u) | ((vcls >> 24u) << 8u);
  // terrain: the class comes from the paving map, sampled per pixel at the world point (the same smooth path edge at
  // every terrain level)

  o.seed = inst[i * 16u + 13u];
  o.id = i;
  o.tone = select(D.tone, tone, D.hasTone == 1u) * bitcast<f32>(inst[i * 16u + 14u]);
  // the world's paint values (half floats: y | z, w | kind)
  let p0 = unpack2x16float(pw.x);
  let p1 = unpack2x16float(pw.y);
  o.paint = vec3f(p0.x, p0.y, p1.x);
  o.flags |= (u32(p1.y + 0.5) & 0xffffu) << 16u;
  o.tmul = bitcast<f32>(inst[i * 16u + 14u]);
  o.origin = T;
  let st = lodUnpack(lodState[i]);
  o.fade = vec2f(0.0);
  if (st.prev != 0xffu) {
    o.fade = vec2f(f32(lodAge(st.start, F.eyeDelta.w)) / max(F.lod.w, 1.0), select(-1.0, 1.0, D.level == st.level));
  }
  return o;
}

struct GOut {
  @location(0) a: vec4f,
  @location(1) b: vec4f,
  @location(2) c: vec4u,
};

// the sun's shadow at an eye-relative point: the finer cascade that holds it, 4 bilinear comparisons (a 4 × 4 texel
// footprint); 1 beyond the cascades
fn shadowAt(rel: vec3f, nW: vec3f) -> f32 {
  for (var k = 0u; k < CASCADES; k++) {
    let texel = 2.0 * F.shadowBox[k].z / f32(textureDimensions(shadowMap).x);
    let q = F.shadowVP[k] * vec4f(rel + nW * texel * 1.5, 1.0);
    let uv = vec2f(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
    if (all(abs(q.xy) < vec2f(0.97)) && q.z > 0.0 && q.z < 1.0) {
      let t = 0.5 / f32(textureDimensions(shadowMap).x);
      var s = 0.0;
      s += textureSampleCompareLevel(shadowMap, shadowCmp, uv + vec2f(-t, -t), k, q.z);
      s += textureSampleCompareLevel(shadowMap, shadowCmp, uv + vec2f(t, -t), k, q.z);
      s += textureSampleCompareLevel(shadowMap, shadowCmp, uv + vec2f(-t, t), k, q.z);
      s += textureSampleCompareLevel(shadowMap, shadowCmp, uv + vec2f(t, t), k, q.z);
      return s * 0.25;
    }
  }
  return 1.0;
}

@fragment
fn fs(v: VOut, @builtin(front_facing) front: bool) -> GOut {
  // (sampled before any branch: an implicit-derivative sample needs uniform control flow)
  let a = textureSample(alphaTex, alphaSamp, v.uv).r;
  let wp = v.rel + F.eye.xyz;
  let pave = textureSampleLevel(paveMap, alphaSamp, (wp.xz - F.paveField.xy) * F.paveField.zw, 0.0).r;
  // where u and v grow on the surface (world metres per uv unit), from the screen derivatives: a property of the mesh,
  // not of the view (taken here, before any branch: derivatives need uniform control flow)
  let dpx = dpdx(v.rel); let dpy = dpdy(v.rel); let dux = dpdx(v.uv); let duy = dpdy(v.uv);
  let det = dux.x * duy.y - dux.y * duy.x;
  let idet = select(0.0, 1.0 / det, abs(det) > 1e-12);
  let Tu = (dpx * duy.y - dpy * dux.y) * idet;
  let Tv = (dpy * dux.x - dpx * duy.x) * idet;
  let alpha = v.flags & 1u;
  let paveBlend = (v.flags >> 1u) & 1u;
  let pattern = (v.flags >> 8u) & 0xffu;
  let kind = v.flags >> 16u;
  let bench = u32(F.layering.z + 0.5);
  if (alpha == 1u && a < D.cutoff && (bench & 4u) == 0u) { discard; }
  // a flowering crown is mostly air, as the references paint it: clusters of blossom along the limbs with the ground
  // and the sky between them (holes in smooth world-anchored noise, so they hold still as the eye moves)
  // (only where the holes are a few pixels across: finer, they would shimmer as the eye moves)
  if (v.cls == 16u && alpha == 1u && v.depth * F.params.x < 0.1 && vnoise(wp * 2.4 + vec3f(3.1, 0.7, 5.3)) * 0.65 + vnoise(wp * 5.5) * 0.35 < 0.52) { discard; }
  var bbDark = 0.0;
  if (D.billboard != 0u) {
    let bb = billboardShape(D.billboard - 1u, v.uv, f32(v.seed & 0xffffu) / 65535.0);
    if (bb.x < 0.5) { discard; }
    bbDark = bb.y;
  }
  if (v.fade.y != 0.0) {
    // the dither cell: about a pixel at this distance, fixed to the world
    let cell = max(0.01, v.depth * F.params.x * 1.5);
    let hsh = hash3(vec3i(floor((v.rel + F.eye.xyz) / cell)));
    if ((v.fade.y > 0.0 && hsh > v.fade.x) || (v.fade.y < 0.0 && hsh <= v.fade.x)) { discard; }
  }
  var nW = normalize(v.nW);
  var cls = v.cls;
  // foliage keeps its bent "crown" normals on both faces of a card (linan's foliage: a card's back is not the crown's
  // inside), biased upward as linan lights it: leaves facing down still see the sky through the gaps of the crown
  let fol = cls == 8u || cls == 9u || cls == 10u || cls == 15u || cls == 16u || cls == 18u || cls == 23u || cls == 26u;
  if (!front && !fol) { nW = -nW; }
  let nL = select(nW, normalize(nW + vec3f(0.0, 0.3, 0.0)), fol);
  let nV = normalize((F.viewRot * vec4f(nW, 0.0)).xyz);
  var o: GOut;
  // the joints drawn on the surface: about a pixel wide; they give way where the courses get smaller than a few pixels.
  // Sizes on the screen are taken from the distance and the angle at which the surface is seen (fp: metres per pixel
  // face-on; a unit of u across the line of sight covers |Tu − dir (dir · Tu)| / fp pixels), so they hold still
  // while the view turns
  let dist = length(v.rel);
  let dir = v.rel / max(dist, 1e-4);
  let fp = max(dist * F.params.x, 1e-5);
  let pxU = length(Tu - dir * dot(dir, Tu)) / fp;
  let pxV = length(Tv - dir * dot(dir, Tv)) / fp;
  var joint = 0.0;
  var block = -1.0;
  if (paveBlend == 1u) {
    if (paths[0].x > 0.0) {
      let pa = pathAt(wp.xz, wp.y);
      cls = select(1u, 27u, pa.x > 0.5);
      if (pa.x > 0.5) {
        // the slab path: courses across it, each a slab long with jittered ends, split into 2 or 3 slabs (the slab
        // length 1.15 m, the path about 3.2 m across); a course seen end-on shrinks by the sine of the view's elevation
        let u = pa.y; let x = pa.z;
        let r = floor(u);
        var du = 1e3;
        for (var k = -1.0; k <= 1.0; k += 1.0) { du = min(du, abs(u - (r + k + 0.18 * (hash3(vec3i(i32(r + k), 7, 1)) - 0.5)))); }
        let rb = select(r, r - 1.0, u < r + 0.18 * (hash3(vec3i(i32(r), 7, 1)) - 0.5));
        let nA = select(2.0, 3.0, hash3(vec3i(i32(rb), 11, 2)) > 0.55);
        var dx = min(x, 1.0 - x) * 3.0;
        for (var j = 1.0; j < nA; j += 1.0) { dx = min(dx, abs(x - (j / nA + 0.14 * (hash3(vec3i(i32(rb), i32(j), 3)) - 0.5)))); }
        let elev = max(abs(dir.y), 0.02);
        let dpxl = min(du * 1.15 * elev, dx * 3.2) / fp;
        let seen = smoothstep(2.5, 6.0, 1.15 * elev / fp);
        joint = (1.0 - smoothstep(0.45, 1.25, dpxl)) * seen;
        block = hash3(vec3i(i32(rb), i32(floor(x * nA)), 5));
      }
    } else {
      cls = select(1u, 27u, pave > 0.5);
    }
  }
  if (pattern != 0u && pattern != 7u) {
    // coursed stone, after linan's bridges (src/bridges/material.js): ashlar, wall, curb, vault (courses across the
    // barrel: u and v swapped), slabs, steps, brick
    let sizes = array<vec2f, 9>(vec2f(1.0), vec2f(1.45, 0.62), vec2f(1.0, 0.42), vec2f(1.9, 10.0), vec2f(1.1, 0.52),
                                 vec2f(1.6, 0.62), vec2f(1.3, 10.0), vec2f(1.0), vec2f(0.36, 0.09));
    let swap = pattern == 4u;
    let q = select(v.uv, v.uv.yx, swap);
    let ppu = select(vec2f(pxU, pxV), vec2f(pxV, pxU), swap);
    let c = courses(q, sizes[min(pattern, 8u)]);
    let dpxl = min(c.x * ppu.x, c.y * ppu.y);
    let seen = smoothstep(2.5, 6.0, c.w * ppu.y);
    joint = (1.0 - smoothstep(0.45, 1.25, dpxl)) * seen;
    block = c.z;
  } else if (pattern == 7u) {
    // the voussoirs of an arch ring: a radial joint at every integer of u
    let g = 0.5 - abs(fract(v.uv.x) - 0.5);
    joint = (1.0 - smoothstep(0.45, 1.25, g * pxU)) * smoothstep(2.5, 6.0, pxU);
    block = hash3(vec3i(i32(floor(v.uv.x)), 31, 3));
  }
  o.a = vec4f(octEncode(nV), v.depth, f32(cls));
  let ndl = max(dot(nL, F.sun.xyz), 0.0);
  // the cast shadow is taken along the geometric normal's sun side: a face turned away gets none of its own
  var sh = 1.0;
  if ((bench & 2u) == 0u) { sh = shadowAt(v.rel, nL); }
  // the albedo: the world's surface functions where it gave the surface a kind, else the measured tone
  var tone = v.tone;
  if (kind != 0u && (bench & 1u) == 0u) {
    tone = surfaceTone(Surface(kind, v.uv, v.paint, wp, nW, v.origin, f32(v.seed & 0xffffu) / 65535.0, v.tone / max(v.tmul, 1e-3))) * v.tmul;
  }
  // thin leaves let the sun through (linan's foliage: three's direct light plus a transmission term, weighed against
  // the leaf's own albedo as its G-buffer reads it): a crown against a low sun is lit, not a black mass
  tone *= 1.0 - 0.55 * bbDark;
  var sunT = ndl * sh;
  if (fol) {
    var tl = 0.3;
    if (cls == 8u) { tl = 0.18; } else if (cls == 16u) { tl = 0.36; } else if (cls == 18u) { tl = 0.09; }
    else if (cls == 23u) { tl = 0.49; } else if (cls == 15u) { tl = 0.3; } else if (cls == 26u) { tl = 0.23; }
    let back = max(-dot(nL, F.sun.xyz), 0.0);
    let fwd = pow(max(dot(dir, F.sun.xyz), 0.0), 6.0);
    let wrap = clamp(dot(nL, F.sun.xyz) * 0.5 + 0.5, 0.0, 1.0);
    sunT = min(sunT + sh * tl / max(tone, 0.03) * (back * (0.5 + 1.5 * fwd) + 0.08 * wrap + 0.35 * fwd), 1.5);
  }
  o.b = vec4f(sunT, 0.5 + 0.5 * nL.y, tone, sh);
  o.c = vec4u(v.seed, v.id, bitcast<u32>(joint), bitcast<u32>(block));
  return o;
}
