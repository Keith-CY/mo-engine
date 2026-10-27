// Painter 2, pass 3: where each pixel sits in its mass (linan's RIDGE_FRAG), at ½ resolution (each texel measured
// from its 2 × 2 block of the G-buffer, in full-resolution pixels):
//   r = px (sheet) below the ridge of the range this pixel belongs to (999: none in reach)
//   g = px (sheet) above the base of the mass (where a nearer form, water or the frame edge cuts it)
//   b = water only: px (sheet) to the nearest shore / object above or below on screen
//   a = px (sheet) above the layer below (water or a much nearer form; 999 at the frame edge / none in reach)
// (up the sheet is −y here)
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> K: Ink2;
@group(0) @binding(2) var gA: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4f };
@vertex
fn vs(@builtin(vertex_index) k: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(vec2f(f32((k << 1u) & 2u), f32(k & 2u)) * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn at(x: f32, y: f32) -> vec4f { return textureLoad(gA, clamp(vec2i(i32(x), i32(y)), vec2i(0), vec2i(K.res.xy) - 1), 0); }

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  _ = F.eye;
  let fc = floor(v.pos.xy) * 2.0 + 1.0;
  let H = K.res.y;
  let a = at(fc.x, fc.y);
  let c = clsOf(a);
  if (c == C_SKY) { return vec4f(999.0); }
  let D = a.z;
  let uK = K.res.z;
  // (6 px steps and one more refinement: the reach and the precision of linan's 3 px steps, half the fetches)
  let stepPx = 6.0 * uK;
  let live = K.look4.z > 0.5;
  if (c == C_WATER) {
    var sh = 999.0;
    for (var i = 1; i <= 40; i++) {
      if (f32(i) * 2.0 > K.look4.w) { break; }   // (the walking painting looks 120 px, a still 240: far lanterns' reflections)
      let dy = f32(i) * stepPx;
      var dir = 0.0;
      // (a boat afloat is no shore: measured from it, the lake's tone and mirror change in a column under its hull)
      if (fc.y - dy > 0.0) { let cb = clsOf(at(fc.x, fc.y - dy)); if (cb != C_WATER && cb != C_SKY && cb != C_BOAT) { dir = -1.0; } }
      if (dir == 0.0 && fc.y + dy < H) { let cb = clsOf(at(fc.x, fc.y + dy)); if (cb != C_WATER && cb != C_SKY && cb != C_BOAT) { dir = 1.0; } }
      if (dir != 0.0) {
        // refine to the pixel (the shore's mirror line would step in whole steps: the reflection drawn in blocks)
        var lo = dy - stepPx; var hi = dy;
        for (var k = 0; k < 4; k++) {
          let mid = 0.5 * (lo + hi);
          let cm = clsOf(at(fc.x, fc.y + dir * mid));
          if (cm != C_WATER && cm != C_SKY && cm != C_BOAT) { hi = mid; } else { lo = mid; }
        }
        sh = hi; break;
      }
    }
    return vec4f(999.0, 999.0, sh / uK, 999.0);
  }
  var dist = 999.0;
  for (var i = 1; i <= 40; i++) {
    let y = fc.y - f32(i) * stepPx;
    if (y <= 0.0) { dist = 999.0; break; }
    let b = at(fc.x, y);
    let cb = clsOf(b);
    // (the bore: its own crest, wherever the wave class ends above; its face is too broken for a depth test)
    if (select(cb == C_SKY || depthOf(b) > D * 1.08 + 8.0, cb != C_WAVE, c == C_WAVE)) {
      // refine to the pixel so ridge bands do not step
      var lo = f32(i - 1) * stepPx; var hi = f32(i) * stepPx;
      for (var k = 0; k < 4; k++) {
        let mid = 0.5 * (lo + hi);
        let m = at(fc.x, fc.y - mid);
        let cm = clsOf(m);
        if (select(cm == C_SKY || depthOf(m) > D * 1.08 + 8.0, cm != C_WAVE, c == C_WAVE)) { hi = mid; } else { lo = mid; }
      }
      dist = hi / uK; break;
    }
  }
  var base = 999.0; var layer = 999.0;
  for (var i = 1; i <= 30; i++) {
    let y = fc.y + f32(i) * stepPx;
    // (the walking painting: the frame's edge is no base, and a nearer form's edge is found to the pixel)
    if (y >= H) { if (base > 998.0 && !live) { base = f32(i) * stepPx / uK; } break; }
    let b = at(fc.x, y);
    let cb = clsOf(b);
    if (base > 998.0 && (cb == C_WATER || depthOf(b) < D * 0.9 - 4.0)) {
      base = f32(i) * stepPx / uK;
      if (live) {
        var lo = f32(i - 1) * stepPx; var hi = f32(i) * stepPx;
        for (var k = 0; k < 4; k++) {
          let mid = 0.5 * (lo + hi);
          let m = at(fc.x, fc.y + mid);
          if (clsOf(m) == C_WATER || depthOf(m) < D * 0.9 - 4.0) { hi = mid; } else { lo = mid; }
        }
        base = hi / uK;
      }
    }
    // the layer below: water, or a form much nearer (a gap between two layers of the view, where mist can lie); only
    // land, trees or water make a layer (a pagoda before a hillside is no gap for mist)
    if (cb == C_WATER || (depthOf(b) < D * 0.6 - 6.0 && (isLand(cb) || isFol(cb)))) {
      var lo = f32(i - 1) * stepPx; var hi = f32(i) * stepPx;
      for (var k = 0; k < 4; k++) {
        let mid = 0.5 * (lo + hi);
        let m = at(fc.x, fc.y + mid);
        let cm = clsOf(m);
        if (cm == C_WATER || (depthOf(m) < D * 0.6 - 6.0 && (isLand(cm) || isFol(cm)))) { hi = mid; } else { lo = mid; }
      }
      layer = hi / uK; break;
    }
  }
  return vec4f(dist, base, 999.0, layer);
}
