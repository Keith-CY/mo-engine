// GPU throughput: frames rendered back to back (no vsync), each waited for on the GPU, at viewpoints and with
// painter-2 stages left out — what each part of the frame costs. Configurations are interleaved (A B C A B C …) so a
// busy GPU shared with other work biases none of them.
//   node tools/bench.mjs --q "scene=…" --vps 2,7 [--w 1440 --h 900] [--frames 40] [--rounds 3]
//                        [--configs "p2;p2-paint;p1"]   (p1 painter 1; p2 painter 2; p2-<stage,…> without those stages;
//                        …/<part,…> without those parts of the frame: cull, shadow, gbuffer; gN: G-buffer bench
//                        flags, 1 no surface functions, 2 no cast shadow, 4 no alpha test; …/rest the eye at rest (shadows not
//                        redrawn); p2-kN: painting bench flags,
//                        1 lines, 2 dark detail, 4 ground patches, 8 leaf marks, 32 皴)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launchChrome, sweepStaleProfiles } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const W = Number(args.w || 1440), H = Number(args.h || 900), N = Number(args.frames || 40), ROUNDS = Number(args.rounds || 3);
const configs = (args.configs || 'p1;p2;p2-paint;p2-lines;p2-ridge;p2-tone,light').split(';');
const server = await startServer(0, ROOT);
sweepStaleProfiles();
const browser = await launchChrome({ width: W, height: H });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  for (const vp of (args.vps || '2').split(',')) {
    await page.goto(`http://127.0.0.1:${server.port}/examples/demo/?${args.q || ''}&vp=${vp}&hud=0`, { waitUntil: 'load' });
    await page.waitForFunction('window.__mo && (window.__mo.ready || window.__mo.error)', { timeout: 600000, polling: 200 });
    await page.evaluate(async () => { await window.__mo.engine.settle(); window.__mo.engine.stop(); });
    await new Promise((r) => setTimeout(r, 1000));
    const res = await page.evaluate(async (configs, N, ROUNDS) => {
      const e = window.__mo.engine, r = e.renderer, dev = e.gpu.device;
      const out = Object.fromEntries(configs.map((c) => [c, []]));
      for (let k = 0; k < ROUNDS; k++) {
        for (const c of configs) {
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
          r.benchSkip = new Set(fc ? fc.split(',').filter((x) => !/^g\d+$/.test(x) && x !== 'nodiscard' && x !== 'rest') : []);
          r.benchFlags = Number((fc ?? '').split(',').find((x) => /^g\d+$/.test(x))?.slice(1) ?? 0);
          const nd = (fc ?? '').split(',').includes('nodiscard');
          if (nd !== r.benchNoDiscard) { r.benchNoDiscard = nd; r.rebuildGbuffer(); }
          // (a walking eye redraws the shadows every frame; the bench measures that, not a resting eye)
          r.benchShadowsAlways = !c.includes('rest');
          for (let i = 0; i < 4; i++) r.render(e.camera, 0);
          await dev.queue.onSubmittedWorkDone();
          const t0 = performance.now();
          for (let i = 0; i < N; i++) { r.render(e.camera, 0); await dev.queue.onSubmittedWorkDone(); }
          out[c].push((performance.now() - t0) / N);
        }
      }
      return Object.fromEntries(Object.entries(out).map(([c, v]) => [c, Math.min(...v)]));
    }, configs, N, ROUNDS);
    console.log(`vp ${vp}: ` + Object.entries(res).map(([c, v]) => `${c} ${v.toFixed(2)} ms`).join(' · '));
  }
} finally {
  await browser.cleanup();
  await server.close();
}
