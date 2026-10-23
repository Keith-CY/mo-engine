// GPU time per pass (ms) at viewpoints, averaged over a few seconds of frames (the renderer's timestamp queries).
//   node tools/gputime.mjs --q "scene=…&p2=1" --vps 2,7 [--w 1440 --h 900] [--secs 4]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launchChrome, sweepStaleProfiles } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const W = Number(args.w || 1440), H = Number(args.h || 900), SECS = Number(args.secs || 4);
const server = await startServer(0, ROOT);
sweepStaleProfiles();
const browser = await launchChrome({ width: W, height: H });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  for (const vp of (args.vps || '2').split(',')) {
    await page.goto(`http://127.0.0.1:${server.port}/examples/demo/?${args.q || ''}&vp=${vp}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__mo && (window.__mo.ready || window.__mo.error)', { timeout: 600000, polling: 200 });
    await new Promise((r) => setTimeout(r, 2000));
    const t = await page.evaluate(async (secs) => {
      const r = window.__mo.engine.renderer, acc = {}, n = {};
      const t0 = performance.now();
      let last = null;
      while (performance.now() - t0 < secs * 1000) {
        await new Promise((res) => setTimeout(res, 100));
        if (r.gpuTimes !== last) { last = r.gpuTimes; for (const [k, v] of Object.entries(last)) { acc[k] = (acc[k] ?? 0) + v; n[k] = (n[k] ?? 0) + 1; } }
      }
      return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, +(v / n[k]).toFixed(2)]));
    }, SECS);
    console.log(`vp ${vp}: ${Object.entries(t).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
} finally {
  await browser.cleanup();
  await server.close();
}
