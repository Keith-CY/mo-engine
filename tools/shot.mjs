// Screenshots of the demo in headless Chrome (GPU, throwaway profile), with the page's console.
//   node tools/shot.mjs [--q "vp=2&scene=…"] [--out out/shots] [--w 1440 --h 900] [--wait 3] [--vps 1,2,3]
//                       [--site out/site]   (a site from tools/site.mjs instead of the demo in the repo)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launchChrome, sweepStaleProfiles } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const W = Number(args.w || 1440), H = Number(args.h || 900);
const OUT = path.resolve(ROOT, args.out || 'out/shots');
fs.mkdirSync(OUT, { recursive: true });

const SITE = args.site ? path.resolve(args.site) : null;
const server = await startServer(0, SITE ?? ROOT);
sweepStaleProfiles();
const browser = await launchChrome({ width: W, height: H });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('console', (m) => console.log(`[page:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log('[page:error]', e.message));
  page.on('response', (r) => { if (r.status() >= 400) console.log(`[page:http] ${r.status()} ${r.url()}`); });
  for (const vp of (args.vps || '0').split(',')) {
    const q = new URLSearchParams(args.q || '');
    if (vp !== '0') q.set('vp', vp);
    await page.goto(`http://127.0.0.1:${server.port}/${SITE ? '' : 'examples/demo/'}?${q}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__mo && (window.__mo.ready || window.__mo.error)', { timeout: 600000, polling: 200 });
    const err = await page.evaluate(() => window.__mo.error || null);
    if (err) { console.log('[shot] error:', err); continue; }
    await new Promise((r) => setTimeout(r, Number(args.wait || 3) * 1000));
    const fps = await page.evaluate(() => { const f = window.__mo.engine.frameTimes.slice(-60); return f.length ? 1000 / (f.reduce((a, b) => a + b, 0) / f.length) : 0; });
    const file = path.join(OUT, `vp${vp}.png`);
    await page.screenshot({ path: file });
    console.log(`[shot] ${path.relative(ROOT, file)}  ${fps.toFixed(0)} fps`);
  }
} finally {
  await browser.cleanup();
  await server.close();
}
