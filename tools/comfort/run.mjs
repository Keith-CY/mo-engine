// The comfort checks (docs/ARCHITECTURE.md §9), in headless Chrome with the GPU and a throwaway profile.
//
//   node tools/comfort/run.mjs [--q "scene=…&vp=3"] [--w 1440 --h 900] [--out out/comfort]
//
//   turn residual  a pure turn (45°/s, 3 s) on the stepped clock; each frame warped by the camera's exact rotation and
//                  compared with the next. What remains is motion the turn does not explain (luma levels, 0 – 255, on
//                  a 720 × 450 copy). The floor is the resampling of a sharp image; a painting that swims sits above it.
//   level steps    LOD levels before and after a pure turn: a turn must change none
//   flick          live clock: turn 0.5 s at 60°/s, rest 0.8 s, five times; the slowest of the first 4 frames of each flick
//   walk + turn    live clock: frame intervals while walking forward and turning 30°/s for 5 s
//   pops           stepped clock: flying forward at 18 m/s for 3 s, frames whose change in some 45 px block jumps above
//                  3 × its neighbours' (a mark or a level that pops instead of moving)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../serve.mjs';
import { launchChrome, sweepStaleProfiles } from '../chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const W = Number(args.w || 1440), H = Number(args.h || 900);
const OUT = path.resolve(ROOT, args.out || 'out/comfort');
fs.mkdirSync(OUT, { recursive: true });
const SW = 720, SH = 450;

/** camera basis as src/core/camera.ts builds it: right, up, back (world) */
function basis(yaw, pitch) {
  const cp = Math.cos(pitch);
  const f = [Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  const r = [Math.cos(yaw), 0, Math.sin(yaw)];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { r, u, b: [-f[0], -f[1], -f[2]] };
}

/** mean |next − prev warped by the rotation| over the pixels both frames see */
function residual(prev, next, p0, p1) {
  const B0 = basis(p0.yaw, p0.pitch), B1 = basis(p1.yaw, p1.pitch);
  const t0 = Math.tan((p0.fovY * Math.PI) / 360), t1 = Math.tan((p1.fovY * Math.PI) / 360), a = SW / SH;
  let sum = 0, n = 0;
  for (let y = 0; y < SH; y++) {
    const ny = 1 - ((y + 0.5) / SH) * 2;
    for (let x = 0; x < SW; x++) {
      const nx = ((x + 0.5) / SW) * 2 - 1;
      // the ray of this pixel in the next frame's camera → world → the previous camera
      const cx = nx * t1 * a, cy = ny * t1, cz = -1;
      const wx = B1.r[0] * cx + B1.u[0] * cy + B1.b[0] * cz, wy = B1.r[1] * cx + B1.u[1] * cy + B1.b[1] * cz, wz = B1.r[2] * cx + B1.u[2] * cy + B1.b[2] * cz;
      const qx = B0.r[0] * wx + B0.r[1] * wy + B0.r[2] * wz, qy = B0.u[0] * wx + B0.u[1] * wy + B0.u[2] * wz, qz = B0.b[0] * wx + B0.b[1] * wy + B0.b[2] * wz;
      if (qz >= 0) continue;
      const sx = ((-qx / qz / (t0 * a)) + 1) / 2 * SW - 0.5, sy = (1 - (-qy / qz / t0)) / 2 * SH - 0.5;
      if (sx < 1 || sy < 1 || sx > SW - 2 || sy > SH - 2) continue;
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy, o = iy * SW + ix;
      const v = (prev[o] * (1 - fx) + prev[o + 1] * fx) * (1 - fy) + (prev[o + SW] * (1 - fx) + prev[o + SW + 1] * fx) * fy;
      sum += Math.abs(next[y * SW + x] - v); n++;
    }
  }
  return sum / Math.max(1, n);
}

const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +s[s.length - 1].toFixed(2) }; };

const server = await startServer(0, ROOT);
sweepStaleProfiles();
const browser = await launchChrome({ width: W, height: H });
const report = { when: new Date().toISOString(), query: args.q || '', size: [W, H] };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('pageerror', (e) => console.log('[page:error]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[page:${m.type()}] ${m.text()}`); });
  const q = new URLSearchParams(args.q || 'vp=3');
  await page.goto(`http://127.0.0.1:${server.port}/examples/demo/?${q}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__mo && (window.__mo.ready || window.__mo.error)', { timeout: 600000, polling: 200 });
  const err = await page.evaluate(() => window.__mo.error || null);
  if (err) throw new Error(err);
  await new Promise((r) => setTimeout(r, 2000));

  // turn residual + level steps, on the stepped clock
  const levelsBefore = await page.evaluate(async () => Array.from(await window.__mo.engine.renderer.readLodState()));
  await page.evaluate(() => { const e = window.__mo.engine; e.beginCapture(); window.__pose0 = e.camera.pose(); });
  const frames = [], poses = [];
  const N = 90, RATE = 45 / 30;   // 45°/s at 30 fps
  for (let k = 0; k < N; k++) {
    const r = await page.evaluate(async (rate, sw, sh) => {
      const e = window.__mo.engine;
      e.walker.look((rate * Math.PI) / 180, 0);
      const f = await e.captureFrame(30);
      // luma at half size (box 2 × 2)
      const out = new Uint8Array(sw * sh), d = f.data, w = f.width;
      const sx = f.width / sw, sy = f.height / sh;
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        let s = 0, n = 0;
        for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
          const o = ((Math.floor(y * sy) + j) * w + Math.floor(x * sx) + i) * 4;
          s += 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; n++;
        }
        out[y * sw + x] = s / n;
      }
      let b = ''; for (let i = 0; i < out.length; i += 0x8000) b += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return { pose: e.camera.pose(), luma: btoa(b) };
    }, RATE, SW, SH);
    frames.push(new Uint8Array(Buffer.from(r.luma, 'base64')));
    poses.push(r.pose);
  }
  const res = [];
  for (let k = 2; k < N; k++) res.push(residual(frames[k - 1], frames[k], poses[k - 1], poses[k]));
  // (resampling a sharp image costs something even when nothing swims: judge against earlier runs and the old
  // renderer, measured the same way — its ink look left 1.75 once its field of view had settled)
  report.turnResidual = stats(res);
  // (read as the turn left them, then the pose goes back and the live loop resumes)
  const levelsAfter = await page.evaluate(async () => { const e = window.__mo.engine; const l = Array.from(await e.renderer.readLodState()); e.camera.setPose(window.__pose0); e.endCapture(); return l; });
  let changed = 0;
  // (the level is the state word's low byte; the rest is the dissolve's bookkeeping)
  for (let i = 0; i < levelsBefore.length; i++) if ((levelsBefore[i] & 0xff) !== 0xff && (levelsAfter[i] & 0xff) !== (levelsBefore[i] & 0xff)) changed++;
  report.levelStepsDuringTurn = changed;
  fs.writeFileSync(path.join(OUT, 'turn-mid.pgm'), Buffer.concat([Buffer.from(`P5 ${SW} ${SH} 255\n`), Buffer.from(frames[N >> 1])]));

  // pops while travelling, stepped
  {
    await page.evaluate(() => { const e = window.__mo.engine; e.beginCapture(); e.walker.mode = 'fly'; e.walker.keys.add('KeyW'); });
    const fr = [];
    for (let k = 0; k < 90; k++) {
      const luma = await page.evaluate(async (sw, sh) => {
        const f = await window.__mo.engine.captureFrame(30);
        const out = new Uint8Array(sw * sh), d = f.data, w = f.width, sx = f.width / sw, sy = f.height / sh;
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
          const o = (Math.floor(y * sy) * w + Math.floor(x * sx)) * 4;
          out[y * sw + x] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
        }
        let b = ''; for (let i = 0; i < out.length; i += 0x8000) b += String.fromCharCode(...out.subarray(i, i + 0x8000));
        return btoa(b);
      }, SW, SH);
      fr.push(new Uint8Array(Buffer.from(luma, 'base64')));
    }
    await page.evaluate(() => { const e = window.__mo.engine; e.walker.keys.delete('KeyW'); e.endCapture(); });
    const BS = 45, bx = SW / BS, by = SH / BS, peak = [];
    for (let k = 1; k < fr.length; k++) {
      let m = 0;
      for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
        let s = 0;
        for (let y = j * BS; y < (j + 1) * BS; y++) for (let x = i * BS; x < (i + 1) * BS; x++) s += Math.abs(fr[k][y * SW + x] - fr[k - 1][y * SW + x]);
        m = Math.max(m, s / (BS * BS));
      }
      peak.push(m);
    }
    const spikes = [];
    for (let k = 3; k < peak.length - 3; k++) {
      const nb = [...peak.slice(k - 3, k), ...peak.slice(k + 1, k + 4)].sort((a, b) => a - b);
      const med = (nb[2] + nb[3]) / 2;
      if (peak[k] > 4 && peak[k] > 3 * (med + 0.5)) spikes.push([k, +peak[k].toFixed(1)]);
    }
    report.pops = { frames: fr.length, spikes: spikes.length, worst: spikes.sort((a, b) => b[1] - a[1]).slice(0, 5) };
  }

  // flick, on the live clock
  report.flick = await page.evaluate(() => new Promise((res) => {
    const e = window.__mo.engine, log = [];
    let last = performance.now(); const t0 = last;
    const f = (now) => {
      const dt = now - last; last = now; const t = now - t0, c = t % 1300, on = c < 500 && t < 6500;
      if (on) e.walker.look((60 * dt / 1000) * Math.PI / 180, 0);
      log.push([dt, on]);
      if (t < 7000) requestAnimationFrame(f);
      else {
        const starts = [];
        log.forEach((x, i) => { if (i && x[1] && !log[i - 1][1]) starts.push(Math.max(...log.slice(i, i + 4).map((y) => y[0]))); });
        const turning = log.filter((x) => x[1]).map((x) => x[0]).sort((a, b) => a - b);
        res({ flickStartsMs: starts.map((x) => +x.toFixed(1)), turnP50: +turning[turning.length >> 1].toFixed(1), turnP95: +turning[Math.floor(turning.length * 0.95)].toFixed(1), turnMax: +turning[turning.length - 1].toFixed(1) });
      }
    };
    requestAnimationFrame(f);
  }));

  // walk + turn, live
  report.walkTurn = await page.evaluate(() => new Promise((res) => {
    const e = window.__mo.engine, ft = [];
    e.walker.keys.add('KeyW');
    let last = performance.now(); const t0 = last;
    const f = (now) => {
      const dt = now - last; last = now; ft.push(dt);
      e.walker.look((30 * dt / 1000) * Math.PI / 180, 0);
      if (now - t0 < 5000) requestAnimationFrame(f);
      else { e.walker.keys.delete('KeyW'); ft.shift(); const s = ft.sort((a, b) => a - b); res({ frames: ft.length, fps: +(1000 * ft.length / 5000).toFixed(1), p50: +s[s.length >> 1].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s[s.length - 1].toFixed(1) }); }
    };
    requestAnimationFrame(f);
  }));
} finally {
  await browser.cleanup();
  await server.close();
}
const file = path.join(OUT, `comfort-${report.when.replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('[comfort] wrote', path.relative(ROOT, file));
