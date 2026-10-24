// The demo: the synthetic town, or a mo-scene from ?scene=<url of its directory>.
//   1 – 9  viewpoints · W A S D, Shift, F, Space / C · drag or double-click (pointer lock) to look · H  the HUD
import { Engine, loadMoScene, syntheticTown, NoWebGPU } from '../../src/index';

declare global {
  interface Window { __mo?: { engine: Engine; ready: boolean; error?: string; go?: (id: number) => void } }
}

const P = new URLSearchParams(location.search);

async function main(): Promise<void> {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const hud = document.getElementById('hud')!;
  if (P.get('hud') === '0') hud.hidden = true;
  const t0 = performance.now();
  const engine = await Engine.create({ canvas, pixelRatio: Number(P.get('dpr')) || undefined });
  console.log(`[demo] engine in ${(performance.now() - t0).toFixed(0)} ms`);
  // a large scene shows how much of it has arrived
  const load = document.getElementById('load')!;
  const onProgress = (done: number, total: number, bytes: number) => {
    load.style.display = 'grid';
    load.textContent = `${P.get('scene')} · ${done} / ${total} files · ${(bytes / 1048576).toFixed(0)} MB`;
  };
  const scene = P.get('scene') ? await loadMoScene(P.get('scene')!, { onProgress }) : syntheticTown(Number(P.get('seed')) || 1103, { heightfield: P.get('terrain') === '1' });
  load.style.display = 'none';
  if (P.get('fade')) engine.renderer.lodFadeFrames = Number(P.get('fade'));
  // ?lod=0.8: every level-of-detail distance scaled (diagnostics)
  if (P.get('lod')) engine.renderer.lodScale = Number(P.get('lod'));
  if (P.get('debug')) engine.renderer.debugView = Number(P.get('debug'));
  // the still-match painter (linan's, pass for pass) unless ?p2=0 asks for Mo's first; ?p2dbg=n its debug views
  engine.renderer.painter = P.get('p2') === '0' ? 1 : 2;
  // ?scale=0.8: a fixed render scale (the painting's size over the screen's); otherwise it follows the frame rate (not
  // under automation: the tools' screenshots and captures keep the full size)
  if (navigator.webdriver) engine.adaptive = false;
  if (P.get('scale')) { engine.adaptive = false; engine.renderScale = Number(P.get('scale')); engine.resize(); }
  if (P.get('p2dbg')) engine.renderer.p2.debug = Number(P.get('p2dbg'));
  // diagnostics: ?paper=0 ?marks=0 ?lines=0 turn the painter's terms off
  if (P.get('paper') === '0' || P.get('marks') === '0' || P.get('lines') === '0') {
    const st = structuredClone(engine.renderer.style);
    if (P.get('paper') === '0') st.look.paperTexture = 0;
    if (P.get('lines') === '0') st.look.lineStrength = 0;
    if (P.get('marks') === '0') { st.base.marks = [0, st.base.marks[1], st.base.marks[2]]; for (const c of Object.values(st.classes)) if (c?.marks) c.marks = [0, c.marks[1], c.marks[2]]; }
    engine.renderer.setStyle(st);
  }
  // ?sun=x,y,z: the direction towards the sun (diagnostics)
  if (P.get('sun')) { const v = P.get('sun')!.split(',').map(Number); const l = Math.hypot(...v); scene.sun = [v[0] / l, v[1] / l, v[2] / l]; }
  const stats = engine.setScene(scene);
  const vp = Number(P.get('vp'));
  if (vp && scene.viewpoints.find((v) => v.id === vp)) engine.goTo(scene.viewpoints.find((v) => v.id === vp)!);
  // ?at=x,y,z&to=x,y,z[&fov=deg]: any camera (diagnostics)
  if (P.get('at') && P.get('to')) {
    const at = P.get('at')!.split(',').map(Number) as [number, number, number], to = P.get('to')!.split(',').map(Number) as [number, number, number];
    engine.goTo({ id: 0, name: 'at', position: at, target: to, fovY: Number(P.get('fov')) || 50 });
  }
  // ?look=id: paint in that look (a viewpoint brings its own)
  if (P.get('look')) engine.setLook(Number(P.get('look')));
  addEventListener('keydown', (e) => {
    // 1 … 9, 0: the viewpoints (0 the tenth); L: the next look
    const n = /^Digit([0-9])$/.exec(e.code);
    if (n) { const v = scene.viewpoints[(Number(n[1]) + 9) % 10]; if (v) engine.goTo(v); }
    if (e.code === 'KeyL' && scene.looks?.length) {
      const i = scene.looks.findIndex((l) => l.id === engine.look?.id);
      engine.setLook(scene.looks[(i + 1) % scene.looks.length].id);
    }
    if (e.code === 'KeyH') hud.hidden = !hud.hidden;
  });
  let last = 0;
  engine.onFrame((e) => {
    const now = performance.now();
    if (now - last < 500) return;
    last = now;
    const ft = e.frameTimes.slice(-120);
    const mean = ft.reduce((a, b) => a + b, 0) / Math.max(1, ft.length);
    const p = e.camera.position;
    hud.textContent = `${scene.name}${engine.look ? ' · ' + engine.look.name : ''} · ${stats.instances} instances · ${(stats.triangles / 1e6).toFixed(1)} M tris (all at level 0+)\n` +
      `${(1000 / mean).toFixed(0)} fps · scale ${e.renderScale} · ${e.walker.mode} · ${p.map((x) => x.toFixed(0)).join(' ')}\n` +
      `GPU ms ${Object.entries(e.renderer.gpuTimes).map(([k, v]) => `${k} ${v}`).join(' · ')}`;
  });
  engine.start();
  window.__mo = { engine, ready: true };
  console.log(`[demo] ready in ${(performance.now() - t0).toFixed(0)} ms`);
}

main().catch((e) => {
  console.error(e);
  window.__mo = { engine: undefined as unknown as Engine, ready: false, error: String(e?.message ?? e) };
  const err = document.getElementById('err')!;
  document.getElementById('load')!.style.display = 'none';
  err.style.display = 'grid';
  err.textContent = e instanceof NoWebGPU ? 'This page needs WebGPU (Chrome, Edge, Safari 26 or Firefox on Windows).' : String(e?.message ?? e);
});
