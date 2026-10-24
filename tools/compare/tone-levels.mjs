// Bakes each look's tone levels for painter 2 (src/render/painter2.ts): at the look's viewpoint, Mo's raw tone
// (?p2dbg=9) is matched to linan's auto-levelled photograph (its ?inkDebug=tone image) by five luminance percentiles
// (2, 10, 50, 90, 98 %) over the land and the buildings (not the sky or the water), and written into the scene's
// looks[].ink.toneLevels as [five raw tones, five tones]. Fixed per look: nothing adapts while walking.
//
//   node tools/compare/tone-levels.mjs --scene out/scenes/linan-city --ref <dir of shot<N>.png> [--vps 1,2,…]
//                                      [--w 1664 --h 928] [--dry 1]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../serve.mjs';
import { launchChrome, sweepStaleProfiles } from '../chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const W = Number(args.w || 1664), H = Number(args.h || 928);
const sceneDir = path.resolve(args.scene), sceneUrl = '/' + path.relative(ROOT, sceneDir) + '/';
const scene = JSON.parse(fs.readFileSync(path.join(sceneDir, 'scene.json'), 'utf8'));
const vps = (args.vps || scene.viewpoints.map((v) => v.id).join(',')).split(',').map(Number);
const PCT = [0.02, 0.1, 0.5, 0.9, 0.98];
const decode = (png) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { input: png, maxBuffer: 1 << 29 });
const pct = (vals) => { vals.sort((a, b) => a - b); return PCT.map((p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))]); };

const server = await startServer(0, ROOT);
sweepStaleProfiles();
const browser = await launchChrome({ width: W, height: H });
const out = {};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  const shoot = async (vp, dbg) => {
    await page.goto(`http://127.0.0.1:${server.port}/examples/demo/?scene=${sceneUrl}&p2=1&p2dbg=${dbg}&vp=${vp}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__mo && (window.__mo.ready || window.__mo.error)', { timeout: 600000, polling: 200 });
    await page.evaluate(() => { document.getElementById('hud').hidden = true; return window.__mo.engine.settle(); });
    await new Promise((r) => setTimeout(r, 2500));
    return decode(await page.screenshot({ type: 'png' }));
  };
  for (const vp of vps) {
    const v = scene.viewpoints.find((x) => x.id === vp);
    const ref = path.join(path.resolve(args.ref), `shot${vp}.png`);
    if (!v || !fs.existsSync(ref)) { console.log(`[levels] viewpoint ${vp}: no viewpoint or no ${ref}`); continue; }
    const raw = await shoot(vp, 9), cls = await shoot(vp, 8);
    const L = decode(fs.readFileSync(ref));
    const a = [], b = [];
    for (let i = 0; i < W * H; i++) {
      const c = Math.round((cls[i * 3] / 255) * 32);
      if (c === 0 || c === 3) continue;
      a.push(raw[i * 3] / 255);
      b.push((0.2126 * L[i * 3] + 0.7152 * L[i * 3 + 1] + 0.0722 * L[i * 3 + 2]) / 255);
    }
    if (a.length < 1000) { console.log(`[levels] viewpoint ${vp}: too little land`); continue; }
    const x = pct(a), y = pct(b);
    // (strictly increasing raw tones)
    for (let k = 1; k < 5; k++) x[k] = Math.max(x[k], x[k - 1] + 0.004);
    out[v.look ?? vp] = [...x, ...y].map((n) => +n.toFixed(4));
    console.log(`[levels] look ${v.look ?? vp}: raw ${x.map((n) => n.toFixed(3)).join(' ')} → ${y.map((n) => n.toFixed(3)).join(' ')}`);
  }
} finally {
  await browser.cleanup();
  await server.close();
}
if (args.dry !== '1') {
  for (const L of scene.looks ?? []) if (out[L.id]) (L.ink ??= {}).toneLevels = out[L.id];
  fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify(scene));
  console.log(`[levels] wrote ${Object.keys(out).length} looks into ${path.join(sceneDir, 'scene.json')}`);
}
