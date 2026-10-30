// The modelled water surface (src/water/surface.ts): its height over the water's level at a world point — short crested
// waves and a breaking front standing across the water, one surface — and the grid vertices lifted onto it.
// F.waterA region (x0, z0, x1, z1); waterB level, waves' height ahead (m), their length (m), 1 when there is a surface;
// waterC the front's ends (a.xz, b.xz; 0 none); waterD its crest height over its first part, at b, a crest's length,
// its bow (m); waterE the side it faces (x, z), the waves' height just behind it (m), their calming distance (m).
const VC_WATER = 0x200000u;

fn wsOn() -> bool { return F.waterB.w > 0.5; }

/** 0 … 1: how far inside the region (1 beyond `feather` m from its edge) */
fn wsInside(xz: vec2f, feather: f32) -> f32 {
  let d = min(min(xz.x - F.waterA.x, F.waterA.z - xz.x), min(xz.y - F.waterA.y, F.waterA.w - xz.y));
  return smoothstep(0.0, feather, d);
}

fn wsHash(n: i32) -> f32 {
  var x = (bitcast<u32>(n) * 2654435761u) ^ 0x5bd1e995u;
  x = (x ^ (x >> 15u)) * 2246822519u; x = (x ^ (x >> 13u)) * 3266489917u;
  return f32(x ^ (x >> 16u)) / 4294967296.0;
}
/** the front's curl at al m along it (as linan's tide.js inkCurl and the painter's boreCurl) */
fn wsCurl(al: f32) -> f32 {
  let P = max(F.waterD.z, 1.0); let fi = floor(al / P);
  let u = al / P - fi;
  return 0.72 + 0.28 * (0.5 - 0.5 * cos(u * 6.2831853)) * (0.55 + 0.45 * wsHash(i32(fi) * 13 + 5));
}
/** the front at a world point: (m along it from a, m ahead of its crest line (− behind), the local crest height (m),
 *  the curl) */
fn wsFront(xz: vec2f) -> vec4f {
  let a = F.waterC.xy; let b = F.waterC.zw; let len = max(length(b - a), 1.0);
  let t2 = (b - a) / len;
  let al = dot(xz - a, t2); let c = wsCurl(al);
  let H = mix(F.waterD.x, F.waterD.y, smoothstep(0.3, 1.0, al / len)) * (0.9 + 0.1 * c) * (0.94 + 0.06 * sin(al / 53.0 + 0.7)) * (1.09 + 0.09 * sin(al / 71.0 + 2.1));
  let u = clamp(al / len, 0.0, 1.0);
  let bow = F.waterD.w * (sin(3.14159265 * u) + 0.3 * sin(9.42477796 * u + 0.8) - 0.3 * sin(0.8) * (1.0 - u) - 0.3 * sin(9.42477796 + 0.8) * u);
  return vec4f(al, dot(xz - a, F.waterE.xy) - bow, H, c);
}

/** the front's section, height / crest height at s (m ahead of the crest line in units of crest height / 16): the
 *  raised churned water behind sloping up to the crest, the face falling steeply to its foot and the water ahead */
fn wsSection(s: f32) -> f32 {
  let S = array<vec2f, 17>(
    vec2f(-170.0, 0.0), vec2f(-110.0, 0.04), vec2f(-70.0, 0.14), vec2f(-45.0, 0.28), vec2f(-28.0, 0.45), vec2f(-16.0, 0.63),
    vec2f(-8.0, 0.8), vec2f(-2.5, 0.92), vec2f(1.5, 0.975), vec2f(3.8, 1.0), vec2f(4.8, 0.88), vec2f(5.7, 0.62),
    vec2f(6.7, 0.4), vec2f(8.5, 0.2), vec2f(13.0, 0.07), vec2f(20.0, 0.02), vec2f(30.0, 0.0));
  if (s <= S[0].x || s >= S[16].x) { return 0.0; }
  var y = 0.0;
  for (var i = 0; i < 16; i++) {
    let p = S[i]; let q = S[i + 1];
    if (s >= p.x && s < q.x) { let t = (s - p.x) / (q.x - p.x); y = mix(p.y, q.y, t * t * (3.0 - 2.0 * t) * 0.5 + t * 0.5); }
  }
  return y;
}

/** the waves: a few crested trains (narrow crests, broad troughs) warped by slow noise, `amp` m high, `len` m long */
fn wsWaves(xz: vec2f, amp: f32, len: f32) -> f32 {
  if (amp <= 0.0) { return 0.0; }
  let warp = vec2f(vnoise(vec3f(xz / 55.0, 1.3)), vnoise(vec3f(xz / 55.0 + 7.1, 4.2))) * 2.0 - 1.0;
  let q = xz + warp * len * 0.6;
  let dirs = array<vec2f, 4>(vec2f(0.94, 0.34), vec2f(0.36, 0.93), vec2f(-0.77, 0.64), vec2f(0.6, -0.8));
  let lens = array<f32, 4>(1.0, 0.63, 0.41, 1.55);
  let amps = array<f32, 4>(0.45, 0.3, 0.2, 0.35);
  var h = 0.0;
  for (var i = 0; i < 4; i++) {
    let th = dot(q, dirs[i]) * 6.2831853 / (len * lens[i]) + f32(i) * 1.7;
    let c = 0.5 + 0.5 * sin(th);
    h += amps[i] * (c * c * c - 0.31);
  }
  // patches of rougher and calmer water
  let rough = 0.6 + 0.8 * vnoise(vec3f(xz / 90.0, 9.4));
  return amp * h * rough * 1.6;
}

/** the waves' height (m) at a world point: the height ahead of the front, heaped up behind it and a little higher just
 *  ahead of its foot, quiet on its face; `fr`: wsFront there, `ends`: how far within the front's length */
fn wsAmp(fr: vec4f, ends: f32) -> f32 {
  var amp = F.waterB.y;
  if (F.waterC.x == 0.0 && F.waterC.z == 0.0) { return amp; }
  let k = fr.z / 16.0;
  let behind = smoothstep(4.0 * k, -6.0 * k, fr.y) * exp(-max(-fr.y, 0.0) / max(F.waterE.w, 1.0));
  amp = mix(amp, F.waterE.z, max(behind, 0.6 * exp(-max(fr.y - 8.0 * k, 0.0) / 60.0)) * ends);
  // (no waves on the face itself: it is the front's own)
  return amp * (1.0 - 0.85 * smoothstep(0.5 * k, 3.0 * k, fr.y) * (1.0 - smoothstep(6.0 * k, 9.0 * k, fr.y)) * ends);
}
/** how far within the front's length (it runs out past its ends into the banks) */
fn wsEnds(al: f32) -> f32 {
  let len = length(F.waterC.zw - F.waterC.xy);
  return smoothstep(-40.0, 0.0, al) * (1.0 - smoothstep(len, len + 40.0, al));
}
fn wsHasFront() -> bool { return F.waterC.x != 0.0 || F.waterC.z != 0.0; }

/** the modelled surface's height over the water's level at a world point (0 outside the region) */
fn wsHeight(xz: vec2f) -> f32 {
  let ins = wsInside(xz, 150.0);
  if (ins <= 0.0) { return 0.0; }
  var h = 0.0;
  var amp = F.waterB.y;
  if (wsHasFront()) {
    let fr = wsFront(xz);
    let ends = wsEnds(fr.x);
    h += fr.z * wsSection(fr.y / (fr.z / 16.0)) * ends;
    amp = wsAmp(fr, ends);
  }
  return (h + wsWaves(xz, amp, F.waterB.z)) * ins;
}
