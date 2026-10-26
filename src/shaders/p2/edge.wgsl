// Painter 2, pass 1: the brush outlines from the G-buffer (linan's EDGE_FRAG): silhouettes from depth (the inverse
// depth's Laplacian: planes give none), normal creases and class boundaries; weighted by class and distance; the near
// side of a silhouette owns the line. → (strength, half width px, the line's normal angle, line type)
//   types: 0 brush, 1 ruler (界画), 2 foliage (soft, broken), 3 rock, 4 the carving (白描)
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> K: Ink2;
@group(0) @binding(2) var gA: texture_2d<f32>;
@group(0) @binding(3) var gB: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4f };
@vertex
fn vs(@builtin(vertex_index) k: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(vec2f(f32((k << 1u) & 2u), f32(k & 2u)) * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn gA_(p: vec2i) -> vec4f { return textureLoad(gA, clamp(p, vec2i(0), vec2i(textureDimensions(gA)) - 1), 0); }

/** per class: silhouette weight, crease weight, crease threshold (1 − cos), base half width (px), line type */
fn classLine(c: u32) -> array<f32, 5> {
  // contours belong to architecture (界画) and a few key forms; trees, hills, grass and water are described by
  // wash, 皴 and dots, so their outlines are faint and broken, and only rock keeps a broken silhouette
  var r = array<f32, 5>(1.0, 0.0, 0.3, 1.2, 0.0);
  // (the references' 界画 lines are fine: the buildings are modelled in tone, the lines only sharpen them)
  if (isArch(c)) { r = array<f32, 5>(0.72, 0.5, 0.22, 0.4, 1.0); }
  if (c == C_ROOF) { r[1] = 0.35; r[2] = 0.6; }   // hips and ridges only; the tile rows are left to the wash
  if (c == C_CITYFAR) { r[0] = 0.32; r[1] = 0.08; r[3] = 0.4; }
  if (c == C_GROUND) { r = array<f32, 5>(0.07, 0.0, r[2], 1.0, 2.0); }
  if (c == C_ROCK) { r = array<f32, 5>(0.4, 0.15, 0.75, 1.2, 3.0); }
  if (isFig(c)) { r = array<f32, 5>(0.6, 0.45, 0.12, 0.42, 4.0); }   // (a fine grey contour: the stone is modelled in tone)
  if (c == C_ROBE) { r = array<f32, 5>(0.65, 0.7, 0.07, 0.5, 4.0); }   // (the robe's folds drawn, as ink08 draws them)
  if (c == C_NICHE) { r = array<f32, 5>(0.8, 0.3, 0.5, 1.1, 3.0); }
  if (c == C_BARK) { r = array<f32, 5>(0.8, 0.1, 0.6, 1.1, r[4]); }
  if (isTree(c)) { r[0] = 0.06; r[3] = 0.6; r[4] = 2.0; }
  if (c == C_BLOSSOM) { r[0] = 0.05; }
  if (c == C_SMALL) { r[0] = 0.04; r[3] = 0.45; r[4] = 2.0; }
  if (c == C_IVY) { r[0] = 0.3; r[3] = 0.45; r[4] = 2.0; }
  if (c == C_BLOOM) { r = array<f32, 5>(0.75, 0.5, 0.2, 0.4, 1.0); }
  if (c == C_PAVE) { r = array<f32, 5>(0.25, 0.0, r[2], 0.6, 1.0); }
  if (c == C_LOTUS) { r[0] = 0.07; r[3] = 0.55; r[4] = 2.0; }
  // the bore: broken lines (the painted bore of the ink-match look: hardly any, its foam melts into the paper)
  if (c == C_WAVE) { let m = K.look3.y > 0.5; r = array<f32, 5>(select(0.55, 0.22, m), 0.0, r[2], select(0.8, 0.5, m), 2.0); }
  return r;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  _ = F.eye;
  let p = vec2i(v.pos.xy);
  let a = gA_(p);
  let c = clsOf(a);
  let D = depthOf(a);
  if (c == C_SKY || c == C_WATER) { return vec4f(0.0); }
  let uK = K.res.z;
  let near = K.sh0.x; let far = K.sh0.y;
  var cl5 = classLine(c);
  let wSil = cl5[0]; var wCr = cl5[1]; let tCr = cl5[2]; let wid = cl5[3]; let typ = cl5[4];
  let n = octDecode(a.xy);
  var s = 0.0; var grad = vec2f(0.0);
  let fol = isFol(c);
  // inner detail (creases) gives way to the outline with distance; roof tile rows go first
  let crK = 1.0 - smoothstep(near * 1.2, far * select(0.3, 0.12, c == C_ROOF), D) * 0.8;
  wCr *= crK;
  // roofs: tile rows only as a suggestion along the eaves (a band just above where the roof ends below)
  var eave = 1.0;
  if (c == C_ROOF) {
    eave = 0.0;
    for (var k = 1; k <= 5; k++) {
      let b = gA_(p + vec2i(0, i32(f32(k) * 4.0 * uK)));
      if (clsOf(b) != C_ROOF) { eave = 1.0 - f32(k - 1) / 5.0; break; }
    }
    wCr *= eave;
  }
  let offs = array<vec2i, 8>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1), vec2i(1, 1), vec2i(-1, -1), vec2i(1, -1), vec2i(-1, 1));
  for (var k = 0; k < 8; k++) {
    let o = offs[k];
    let b = gA_(p + o); let b2 = gA_(p - o);
    let cb = clsOf(b);
    let bz = depthOf(b); let b2z = depthOf(b2);
    // silhouette: inverse depth is affine across a plane, so its Laplacian only fires at depth breaks
    let lap = (2.0 / D - 1.0 / bz - 1.0 / b2z) * D;
    var tS = select(0.035, select(0.12, 0.35, isFol(cb)), fol);
    // tile rolls: only big breaks inside a roof draw (the hips, the eaves over the wall); rows are left to the wash
    if (c == C_ROOF && cb == C_ROOF) { tS = mix(0.6, 0.06, eave); }
    if (c == C_CITYFAR && cb == C_CITYFAR) { tS = 0.2; }
    if (c == C_WAVE && cb == C_WAVE) { tS = 99.0; }   // (the bore's broken face draws no inner lines: the curls are painted)
    let sil = smoothstep(tS, tS * 2.5, lap) * step(D * 1.01, bz);
    // class boundary (the nearer side draws it); water edges belong to the land
    var cl = 0.0;
    if (cb != c) {
      cl = select(0.0, 1.0, bz >= D * 0.995 || cb == C_WATER);
      if (fol && isFol(cb)) { cl = 0.0; }
      if (fol && !isFol(cb)) { cl *= 0.6; }
      if (cb == C_WATER) { cl *= 0.55; }
      if ((c == C_GROUND && cb == C_SMALL) || (c == C_SMALL && cb == C_GROUND)) { cl *= 0.15; }
      if (c == C_GROUND && isTree(cb)) { cl *= 0.4; }
      if (isArch(c) && isArch(cb)) { cl *= 0.8; }
      // (the robe's edge over the bare stone: its tone tells it, a line along the mesh's triangles would be stepped)
      if (isFig(c) && isFig(cb)) { cl = 0.0; }
      // (a hill, a wood or a rock against the sky is a soft edge of wash, hardly a line: the references draw no contour)
      if (cb == C_SKY) { cl = select(select(1.0, 0.45, c == C_ROCK), 0.15, fol || c == C_GROUND); }
    }
    // crease
    var cr = 0.0;
    if (cb == c && abs(bz - D) < D * 0.03) {
      let nb = octDecode(b.xy);
      cr = smoothstep(tCr, tCr * 1.8, 1.0 - dot(n, nb)) * wCr;
    }
    var e = max(max(sil * wSil, cl * wSil), cr);
    if (k >= 4) { e *= 0.85; }
    s = max(s, e);
    grad += vec2f(o) * e;
  }
  // crevices: the sky light drops into folds and cracks (rock, the carving, bark)
  if (isLand(c) || c == C_BARK) {
    let sk = textureLoad(gB, p, 0).y;
    if (sk > 0.0) {
      var avg = 0.0; var nn = 0.0;
      let o3 = array<vec2i, 8>(vec2i(3, 0), vec2i(-3, 0), vec2i(0, 3), vec2i(0, -3), vec2i(2, 2), vec2i(-2, -2), vec2i(2, -2), vec2i(-2, 2));
      for (var k = 0; k < 8; k++) {
        let q = clamp(p + o3[k], vec2i(0), vec2i(textureDimensions(gA)) - 1);
        let bb = textureLoad(gB, q, 0);
        let aa = gA_(q);
        if (bb.y > 0.0 && abs(depthOf(aa) - D) < D * 0.05) { avg += bb.y; nn += 1.0; }
      }
      if (nn > 3.0) {
        avg /= nn;
        let w = select(select(select(0.5, 0.35, c == C_ROCK), 0.6, isFig(c)), 0.0, c == C_GROUND || c == C_PAVE);
        s = max(s, smoothstep(select(0.45, 0.25, isFig(c)), select(0.75, 0.55, isFig(c)), (avg - sk) / max(avg, 1e-4)) * w);
      }
    }
  }
  // distance: full weight at near, none at far (log scale)
  let f = clamp(1.0 - log2(max(D, 1.0) / near) / log2(far / near), 0.0, 1.0);
  let hw = wid * K.st1.w * mix(0.45, 1.25, f) * uK;
  s *= smoothstep(0.0, 0.3, f);
  let ang = atan2(grad.y, grad.x + 1e-6);
  return vec4f(s, hw, ang, typ);
}
