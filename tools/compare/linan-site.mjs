// The same camera path as tools/capture.mjs, through linan's own renderer (the live site, github.com/Keith-CY/linan:
// three.js WebGL2 and its screen-space painter), for side-by-side comparisons with Mo. Frame by frame on a virtual
// clock (linan's tools/capture-walk.mjs does the same for its walk video): the page's frame loop, performance.now()
// and its animations advance 1/fps per frame however slowly the frames are captured; where the page waits on real
// work (its still view preparing and accumulating), the clock is stopped and nothing is recorded. Its still view,
// which takes over when the eye rests, is kept: it is what a visitor sees.
//
//   node tools/compare/linan-site.mjs --site ~/Documents/Github/hangzhou --path path.json [--out out/compare/linan]
//                                     [--w 1440 --h 900] [--fps 30] [--name linan.mp4] [--crf 20]
//
// path.json as tools/capture.mjs; a key's "place" (1 … 10) teleports there first (its look and field of view), its
// "look" sets the time of day, "fly" flies; between keys the eye eases from one pose to the next.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../serve.mjs';
import { launchChrome, sweepStaleProfiles } from '../chrome.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.site || !args.path) throw new Error('--site <linan checkout> --path path.json');
const SITE = path.resolve(args.site.replace(/^~/, process.env.HOME));
const W = Number(args.w || 1440), H = Number(args.h || 900), FPS = Number(args.fps || 30), FRAME_MS = 1000 / FPS;
const OUT = path.resolve(args.out || 'out/compare/linan');
const keys = JSON.parse(fs.readFileSync(path.resolve(args.path), 'utf8')).keys;
const T = keys[keys.length - 1].t;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function poseAt(t) {
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  if (b === a || b.cut) return { ...a };
  const u = Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-6, b.t - a.t))), s = u * u * (3 - 2 * u);
  const mix = (p, q) => p.map((v, k) => v + (q[k] - v) * s);
  return { ...a, at: mix(a.at, b.at), to: mix(a.to, b.to) };
}
// (linan's walker: yaw = atan2(−dx, −dz), pitch = asin(dy), rotation order YXZ)
const angles = (p) => {
  const d = p.to.map((v, k) => v - p.at[k]), l = Math.hypot(...d);
  return [(Math.atan2(-d[0], -d[2]) * 180) / Math.PI, (Math.asin(d[1] / l) * 180) / Math.PI];
};

const CLOCK = `(async () => {
  const realRAF = window.requestAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);
  const vc = (window.__vc = { t: 0, q: [], anims: new Map() });
  window.requestAnimationFrame = (cb) => { vc.q.push(cb); return vc.q.length; };
  await new Promise((r) => realRAF(() => realRAF(r)));
  vc.t = realNow();
  performance.now = () => vc.t;
  for (const a of document.getAnimations()) { try { a.finish(); } catch {} vc.anims.set(a, null); }
  window.__vstep = async (ms, n = 1) => {
    for (let k = 0; k < n; k++) {
      vc.t += ms;
      for (const a of document.getAnimations()) {
        let s = vc.anims.get(a);
        if (s === null) continue;
        if (!s) { s = { t0: vc.t - ms }; vc.anims.set(a, s); a.pause(); }
        a.currentTime = vc.t - s.t0;
      }
      const q = vc.q; vc.q = [];
      for (const cb of q) cb(vc.t);
    }
    await new Promise((r) => realRAF(() => r()));
    return true;
  };
  return true;
})()`;

const server = await startServer(0, SITE);
sweepStaleProfiles();
const browser = await launchChrome({ width: W, height: H });
const t0 = Date.now();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('pageerror', (e) => console.log('[page:error]', e.message));
  const first = keys.find((k) => k.place) || { place: 2 };
  const qs = new URLSearchParams({ q: 'high', scale: '1', mblurMax: '1', at: String(first.place) });
  await page.goto(`http://127.0.0.1:${server.port}/index.html?${qs}`, { waitUntil: 'load', timeout: 3600 * 1000 });
  await page.waitForFunction('window.__READY === true || !!window.__RENDER_ERROR', { timeout: 3600 * 1000, polling: 500 });
  console.log(`[linan] world ready in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const ev = (e) => page.evaluate(e);
  await ev(`(async () => { await window.engine.registry.stillWater; const t0 = performance.now(); while (!(window.__explore.country()?.ready) && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 200)); return true; })()`);
  await ev(CLOCK);
  const n = Math.round(T * FPS) + 1;
  let frame = 0, place = null, look = null, mode = null;
  for (let f = 0; f < n; f++) {
    const p = poseAt(f / FPS);
    if (p.place && p.place !== place) { await ev(`window.__explore.teleport(${p.place})`); place = p.place; look = null; }
    if (p.look && p.look !== look) { await ev(`window.__explore.setLook(${p.look})`); look = p.look; }
    const m = p.fly ? 'fly' : 'walk';
    if (m !== mode) { await ev(`window.__explore.mode('${m}')`); mode = m; }
    const [yaw, pitch] = angles(p);
    await ev(`window.__explore.setPose(${JSON.stringify(p.at)}, ${yaw}, ${pitch})`);
    // the page's waits on real work, off the clock, then one frame of page time
    await ev(`(async () => { const t0 = Date.now(); while (['prep', 'accum'].includes(window.__explore.phase()) && Date.now() - t0 < 120000) await window.__vstep(0); return true; })()`);
    await page.evaluate((ms) => window.__vstep(ms, 1), FRAME_MS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 94, optimizeForSpeed: true });
    fs.writeFileSync(path.join(OUT, `f${String(frame++).padStart(5, '0')}.jpg`), buf);
    if (f % 60 === 0) console.log(`[linan] ${f}/${n} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
} finally {
  await browser.cleanup();
  await server.close();
}
const name = args.name || 'linan.mp4';
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(OUT, 'f%05d.jpg'),
  '-vf', 'scale=in_range=full:out_range=tv', '-c:v', 'libx264', '-crf', String(args.crf ?? 20), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(OUT, name)]);
console.log(`[linan] ${path.join(OUT, name)}`);
