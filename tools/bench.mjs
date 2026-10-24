// GPU throughput: frames rendered back to back (no vsync), each waited for on the GPU, at viewpoints and with
// painter-2 stages left out — what each part of the frame costs. Configurations are interleaved (A B C A B C …) so a
// busy GPU shared with other work biases none of them.
//   node tools/bench.mjs --q "scene=…" --vps 2,7 [--w 1440 --h 900] [--frames 40] [--rounds 3]
//                        [--configs "p2;p2-paint;p1"]   (p1 painter 1; p2 painter 2; p2-<stage,…> without those stages;
//                        …/<part,…> without those parts of the frame: cull, shadow, gbuffer; gN: G-buffer bench
//                        flags, 1 no surface functions, 2 no cast shadow, 4 no alpha test, 8 a bare fragment shader (the geometry alone); …/rest the eye at rest (shadows not
//                        redrawn); …/oN: renderer.perfOff bits (the frame-rate measures left out, renderer.ts); p2-kN:
//                        painting bench flags, 1 lines, 2 dark detail, 4 ground patches, 8 leaf marks, 32 皴)
//                        [--page linan]  linan's page (its LOD scale 0.8, its viewpoints), the city loaded once for every
//                                        viewpoint (the demo page loads it again for each)
//                        [--warm 4]      frames drawn before each timed run (a config's first frames settle)
//                        [--gpu 1]       each pass's GPU time too (timestamp queries, the median of the best round)
//                        [--base dir]    a second build (a checkout of another commit, built, with out/scenes) on a page
//                                        of its own: every config timed on both pages, interleaved ("config@base")
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launchChrome, sweepStaleProfiles } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const W = Number(args.w || 1440), H = Number(args.h || 900), N = Number(args.frames || 40), ROUNDS = Number(args.rounds || 3);
const configs = (args.configs || 'p1;p2;p2-paint;p2-lines;p2-ridge;p2-tone,light').split(';');
const linan = args.page === 'linan';
const servers = [await startServer(0, ROOT)];
if (args.base) servers.push(await startServer(0, path.resolve(args.base)));
sweepStaleProfiles();
const browser = await launchChrome({ width: W, height: H });

/** one page per build, loaded at a viewpoint (linan's page: once, then it goes from place to place) */
async function open(server, vp) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('pageerror', (e) => console.log('[page:error]', e.message));
  const url = linan
    ? `http://127.0.0.1:${server.port}/examples/linan/?${args.q || ''}&vp=${vp}&ui=0&wm=0`
    : `http://127.0.0.1:${server.port}/examples/demo/?${args.q || ''}&vp=${vp}&hud=0`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__mo && (window.__mo.ready || window.__mo.error)', { timeout: 900000, polling: 200 });
  const err = await page.evaluate(() => window.__mo.error || null);
  if (err) throw new Error(err);
  return page;
}
/** at a viewpoint, settled (finer levels fetched, the dissolves done), the live loop stopped */
async function settle(page, vp) {
  if (linan) await page.evaluate((id) => { window.__mo.engine.start(); window.__mo.go(id); }, Number(vp));
  await page.evaluate(async () => { await window.__mo.engine.settle(); });
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => window.__mo.engine.stop());
}

/** times one config on a page (ms per frame); the caller keeps the least of the rounds */
function timeConfig(page, c) {
  return page.evaluate(async (c, N, gpu, warm) => {
    const e = window.__mo.engine, r = e.renderer, dev = e.gpu.device;
    // (a config: painter 1 or 2, minus painter-2 stages, minus frame parts after a '/': p2-paint/shadow)
    const [pc, fc] = c.split('/');
    r.painter = pc === 'p1' ? 1 : 2;
    const pp = pc.startsWith('p2-') ? pc.slice(3).split(',') : [];
    r.p2.skip = new Set(pp.filter((x) => !/^k\d+$/.test(x) && !x.startsWith('no:')));
    r.p2.benchFlags = Number(pp.find((x) => /^k\d+$/.test(x))?.slice(1) ?? 0);
    // (p2-no:lines+leaf…: those parts compiled out)
    const no = (pp.find((x) => x.startsWith('no:')) ?? 'no:').slice(3).split('+').filter(Boolean);
    const want = Object.fromEntries(Object.keys(r.p2.features).map((k) => [k, !no.includes(k)]));
    if (JSON.stringify(want) !== JSON.stringify(r.p2.features)) { r.p2.features = want; await r.p2.reinit(); }
    const parts = (fc ?? '').split(',').filter(Boolean);
    r.benchSkip = new Set(parts.filter((x) => !/^[go]\d+$/.test(x) && x !== 'nodiscard' && x !== 'rest'));
    r.benchFlags = Number(parts.find((x) => /^g\d+$/.test(x))?.slice(1) ?? 0);
    // (the frame-rate measures a config leaves out; a build without them has no perfOff)
    if ('perfOff' in r) r.perfOff = Number(parts.find((x) => /^o\d+$/.test(x))?.slice(1) ?? 0);
    const nd = parts.includes('nodiscard');
    if (nd !== r.benchNoDiscard) { r.benchNoDiscard = nd; r.rebuildGbuffer(); }
    // (a walking eye redraws the shadows every frame; the bench measures that, not a resting eye)
    r.benchShadowsAlways = !c.includes('rest');
    for (let i = 0; i < warm; i++) r.render(e.camera, 0);
    await dev.queue.onSubmittedWorkDone();
    // (--gpu: the passes' own times as well, from the renderer's timestamp queries on every frame)
    const passes = {};
    r.timerEvery = gpu ? 1 : 30;
    const t0 = performance.now(), each = [];
    for (let i = 0; i < N; i++) {
      const last = r.gpuTimes, t1 = performance.now();
      r.render(e.camera, 0); await dev.queue.onSubmittedWorkDone();
      each.push(performance.now() - t1);
      if (gpu && r.gpuTimes !== last) for (const [k, v] of Object.entries(r.gpuTimes)) (passes[k] ??= []).push(v);
    }
    const ms = (performance.now() - t0) / N;
    r.timerEvery = 30;
    return { ms, each, passes: Object.fromEntries(Object.entries(passes).map(([k, v]) => [k, v.sort((a, b) => a - b)[v.length >> 1]])) };
  }, c, N, !!args.gpu, Number(args.warm || 4));
}

try {
  let pages = [];
  for (const vp of (args.vps || '2').split(',')) {
    if (!pages.length || !linan) {
      for (const p of pages) await p.close();
      pages = [];
      for (const s of servers) pages.push(await open(s, vp));
    }
    for (const p of pages) { await p.bringToFront(); await settle(p, vp); }
    const out = {};
    for (let k = 0; k < ROUNDS; k++) {
      for (const c of configs) {
        // (the page timed is brought to the front: a hidden page's frames wait)
        for (let pi = 0; pi < pages.length; pi++) {
          if (pages.length > 1) await pages[pi].bringToFront();
          (out[pi ? `${c}@base` : c] ??= []).push(await timeConfig(pages[pi], c));
        }
      }
    }
    // (the least of the rounds' means and their median; and, steadiest on a GPU another process keeps busy, each
    // config against the first one in the same round — the median of those ratios)
    const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
    const ref = Object.values(out)[0];
    console.log(`vp ${vp}: ` + Object.entries(out).map(([c, v], j) => `${c} ${Math.min(...v.map((x) => x.ms)).toFixed(2)} (med ${med(v.map((x) => x.ms)).toFixed(2)}` +
      (j ? `, ×${med(v.map((x, k) => x.ms / ref[k].ms)).toFixed(3)}` : '') + ') ms').join(' · '));
    // (the round with the shortest frames, its passes' median times)
    if (args.gpu) for (const [c, v] of Object.entries(out)) {
      const best = v.reduce((a, b) => (b.ms < a.ms ? b : a));
      console.log(`  ${c}: ` + Object.entries(best.passes).map(([k, t]) => `${k} ${t.toFixed(2)}`).join(' · '));
    }
  }
} finally {
  await browser.cleanup();
  for (const s of servers) await s.close();
}
