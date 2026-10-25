// The places of linan's page painted one after another in one page load (the city loaded once): for comparing the look
// with reference paintings quickly. Each view is settled (finer levels fetched) and held still ~1.5 s before its shot.
//   node tools/look.mjs [--vps 1,2,…] [--out out/look] [--w 1664 --h 928] [--q "scene=…"] [--refs dir]
//   --refs: pairs (reference left, Mo right) from dir/inkNN.jpg into <out>/pairs/pN.jpg
//   --walk "vp:metres:turn°,…": instead of the viewpoints, an eye that went to a place, walked that far ahead (on the
//   ground, eye 1.6 m) and turned (walk-<vp>-<m>-<turn>.png)
//   --cams "x,y,z,tx,ty,tz[,fov];…": instead, eyes placed by hand looking at a target (cam1.png, cam2.png, …)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launchChrome, sweepStaleProfiles } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const W = Number(args.w || 1664), H = Number(args.h || 928);
const OUT = path.resolve(ROOT, args.out || 'out/look');
fs.mkdirSync(OUT, { recursive: true });
const vps = (args.vps || '1,2,3,4,5,6,7,8,9,10').split(',').map(Number);

const server = await startServer(0, ROOT);
sweepStaleProfiles();
const browser = await launchChrome({ width: W, height: H });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log(`[page:${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => console.log('[page:error]', e.message));
  const q = new URLSearchParams(args.q || 'scene=/out/scenes/packed/linan-city/');
  q.set('ui', '0'); q.set('wm', '0'); q.set('vp', String(vps[0]));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${server.port}/examples/linan/?${q}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__mo && (window.__mo.ready || window.__mo.error)', { timeout: 600000, polling: 200 });
  const err = await page.evaluate(() => window.__mo.error || null);
  if (err) throw new Error(err);
  console.log(`[look] loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const walks = (args.walk || '').split(',').filter(Boolean).map((w) => w.split(':').map(Number));
  for (const [vp, m, turn] of walks) {
    await page.evaluate(([id, m, turn]) => {
      const e = window.__mo.engine; window.__mo.go(id);
      const c = e.camera, p = c.position;
      const nx = p[0] + Math.sin(c.yaw) * m, nz = p[2] - Math.cos(c.yaw) * m;
      const g = e.walker.ground(nx, nz);
      p[0] = nx; p[2] = nz; if (Number.isFinite(g)) p[1] = g + 1.6;
      c.yaw += (turn * Math.PI) / 180; c.pitch = 0;
      e.walker.mode = 'walk';
    }, [vp, m, turn || 0]);
    await page.evaluate(() => window.__mo.engine.settle());
    await new Promise((r) => setTimeout(r, Number(args.wait || 1.5) * 1000));
    const file = path.join(OUT, `walk-${vp}-${m}-${turn || 0}.png`);
    await page.screenshot({ path: file });
    console.log(`[look] ${path.relative(ROOT, file)}`);
  }
  const cams = (args.cams || '').split(';').filter(Boolean).map((c) => c.split(',').map(Number));
  for (const [i, c] of cams.entries()) {
    await page.evaluate((c) => {
      const e = window.__mo.engine; window.__mo.go(c[7] || 8);
      e.camera.lookAt([c[0], c[1], c[2]], [c[3], c[4], c[5]]);
      if (c[6]) e.camera.fovY = c[6];
      e.walker.pin();
    }, c);
    await page.evaluate(() => window.__mo.engine.settle());
    await new Promise((r) => setTimeout(r, Number(args.wait || 1.5) * 1000));
    const file = path.join(OUT, `cam${i + 1}.png`);
    await page.screenshot({ path: file });
    console.log(`[look] ${path.relative(ROOT, file)}`);
  }
  for (const vp of walks.length || cams.length ? [] : vps) {
    await page.evaluate((id) => window.__mo.go(id), vp);
    await page.evaluate(() => window.__mo.engine.settle());
    await new Promise((r) => setTimeout(r, Number(args.wait || 1.5) * 1000));
    const fps = await page.evaluate(() => { const f = window.__mo.engine.frameTimes.slice(-40); return f.length ? 1000 / (f.reduce((a, b) => a + b, 0) / f.length) : 0; });
    const file = path.join(OUT, `vp${vp}.png`);
    await page.screenshot({ path: file });
    console.log(`[look] ${path.relative(ROOT, file)}  ${fps.toFixed(0)} fps`);
    if (args.refs) {
      fs.mkdirSync(path.join(OUT, 'pairs'), { recursive: true });
      const ref = path.join(path.resolve(args.refs), `ink${String(vp).padStart(2, '0')}.jpg`);
      if (fs.existsSync(ref)) {
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', ref, '-i', file, '-filter_complex',
          '[0]scale=960:535[a];[1]scale=960:535[b];[a][b]hstack', '-q:v', '3', path.join(OUT, 'pairs', `p${vp}.jpg`)]);
      }
    }
  }
} finally {
  await browser.cleanup();
  await server.close();
}
