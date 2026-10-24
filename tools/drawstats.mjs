// What a scene draws at a viewpoint: per pass the instances and triangles, and the heaviest slots (mesh, level).
//   node tools/drawstats.mjs --q "scene=…&vp=2" [--w 1664 --h 928] [--top 15]
//   node tools/drawstats.mjs --page linan --q "scene=…" --vps 1,8 [--top 15]   (linan's page, its LOD scale, the city
//                                                                              loaded once)
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startServer } from './serve.mjs';
import { launchChrome, sweepStaleProfiles } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const W = Number(args.w || 1664), H = Number(args.h || 928);
const linan = args.page === 'linan';
const vps = (args.vps || '').split(',').filter(Boolean);
const server = await startServer(0, ROOT);
sweepStaleProfiles();
const browser = await launchChrome({ width: W, height: H });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('pageerror', (e) => console.log('[page:error]', e.message));
  const first = vps[0] ? `&vp=${vps[0]}` : '';
  await page.goto(linan ? `http://127.0.0.1:${server.port}/examples/linan/?dpr=1&ui=0&wm=0&${args.q || ''}${first}`
    : `http://127.0.0.1:${server.port}/examples/demo/?dpr=1&${args.q || ''}${first}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__mo && (window.__mo.ready || window.__mo.error)', { timeout: 900000, polling: 200 });
  for (const vp of vps.length ? vps : ['']) {
    if (linan && vp) await page.evaluate((id) => window.__mo.go(id), Number(vp));
    await page.evaluate(() => window.__mo.engine.settle());
    await new Promise((r) => setTimeout(r, 2500));
    const st = await page.evaluate(async (top) => window.__mo.engine.renderer.readDrawStats(top), Number(args.top || 15));
    const M = (x) => (x / 1e6).toFixed(2) + ' M';
    if (vp) console.log(`vp ${vp}`);
    st.passes.forEach((p, k) => console.log(`${['view', 'cascade 0', 'cascade 1', 'view, dissolving', 'view, second phase'][k] ?? k}: ${p.instances} instances, ${M(p.triangles)} triangles${p.undrawn ? ` (${p.undrawn} listed with no triangles)` : ''}`));
    for (const h of st.heaviest) console.log(`  ${['view', 'c0', 'c1', 'fade', 'late'][h.pass]}  ${M(h.triangles).padStart(9)}  ${String(h.instances).padStart(6)} × ${h.mesh} (level ${h.level})`);
  }
} finally {
  await browser.cleanup();
  await server.close();
}
