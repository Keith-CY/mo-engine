// A video of the demo along a camera path, frame by frame on the engine's stepped clock (however slowly the frames are
// made, the motion plays at its real pace), in headless Chrome (GPU, throwaway profile), then encoded with ffmpeg.
//
//   node tools/capture.mjs --q "scene=/out/scenes/…/" --path path.json [--out out/capture] [--w 1440 --h 900]
//                          [--fps 30] [--name mo.mp4] [--crf 20] [--settle 1.5]
//
// path.json: { "keys": [ { "t": 0, "at": [x, y, z], "to": [x, y, z], "fov": 42, "look": 2, "fly": false }, … ] }
// Between two keys the eye and its target ease (smoothstep) from one to the next; a key with "cut": true jumps to it
// (and the painting settles for --settle s before recording goes on, as a viewpoint change on the site dissolves in).
// Walking keys ("fly" false) keep the eye on the ground at eye height. The same path drives linan's own capture, so
// the two can be laid side by side.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launchChrome, sweepStaleProfiles } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const W = Number(args.w || 1440), H = Number(args.h || 900), FPS = Number(args.fps || 30);
const OUT = path.resolve(ROOT, args.out || 'out/capture');
const SETTLE = Number(args.settle ?? 1.5);
if (!args.path) throw new Error('--path path.json');
const keys = JSON.parse(fs.readFileSync(path.resolve(args.path), 'utf8')).keys;
const T = keys[keys.length - 1].t;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/** the pose at time t: eased between the keys around it */
function poseAt(t) {
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  if (b === a || b.cut) return { ...a };
  const u = Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-6, b.t - a.t))), s = u * u * (3 - 2 * u);
  const mix = (p, q) => p.map((v, k) => v + (q[k] - v) * s);
  return { ...a, at: mix(a.at, b.at), to: mix(a.to, b.to), fov: (a.fov ?? 42) + ((b.fov ?? 42) - (a.fov ?? 42)) * s };
}

const server = await startServer(0, ROOT);
sweepStaleProfiles();
const browser = await launchChrome({ width: W, height: H });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[page:error] ${m.text()}`); });
  page.on('pageerror', (e) => console.log('[page:error]', e.message));
  const q = new URLSearchParams(args.q || '');
  q.set('dpr', '1');
  await page.goto(`http://127.0.0.1:${server.port}/examples/demo/?${q}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__mo && (window.__mo.ready || window.__mo.error)', { timeout: 900000, polling: 200 });
  await page.evaluate(() => { document.getElementById('hud').hidden = true; window.__mo.engine.beginCapture(); });
  const n = Math.round(T * FPS) + 1;
  let lastLook = null, settle = 0, written = 0;
  const t0 = Date.now();
  for (let f = 0, k = 0; f < n; f++) {
    const t = f / FPS;
    const p = poseAt(t);
    // a cut: the new pose, then the painting settles unrecorded
    const cutNow = f === 0 || keys.some((x) => x.cut && Math.abs(x.t - t) < 0.5 / FPS);
    if (cutNow) settle = Math.round(SETTLE * FPS);
    const frames = 1 + settle;
    settle = 0;
    const jpg = await page.evaluate(async (p, look, frames, cut) => {
      const e = window.__mo.engine;
      if (cut) { e.camera.lookAt(p.at, p.to); e.renderer.cut(); }
      if (p.look !== undefined && p.look !== look) e.setLook(p.look);
      e.walker.mode = p.fly ? 'fly' : 'walk';
      e.camera.fovY = p.fov ?? 42;
      let px;
      for (let i = 0; i < frames; i++) {
        e.camera.lookAt(p.at, p.to);
        px = await e.captureFrame(30);
      }
      const c = (window.__cap ??= document.createElement('canvas'));
      c.width = px.width; c.height = px.height;
      const g = c.getContext('2d');
      g.putImageData(new ImageData(new Uint8ClampedArray(px.data.buffer, px.data.byteOffset, px.width * px.height * 4), px.width, px.height), 0, 0);
      return c.toDataURL('image/jpeg', 0.94).slice('data:image/jpeg;base64,'.length);
    }, p, lastLook, frames, cutNow);
    lastLook = p.look ?? lastLook;
    fs.writeFileSync(path.join(OUT, `f${String(k++).padStart(5, '0')}.jpg`), Buffer.from(jpg, 'base64'));
    written++;
    if (f % 60 === 0) console.log(`[capture] ${f}/${n} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  console.log(`[capture] ${written} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} finally {
  await browser.cleanup();
  await server.close();
}
const name = args.name || 'mo.mp4';
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(OUT, 'f%05d.jpg'),
  '-c:v', 'libx264', '-crf', String(args.crf ?? 20), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(OUT, name)]);
console.log(`[capture] ${path.join(OUT, name)}`);
