// The demo: the synthetic town, or a mo-scene from ?scene=<url of its directory>.
//   1 – 9  viewpoints · W A S D, Shift, F, Space / C · drag or double-click (pointer lock) to look · H  the HUD
import { Engine, loadMoScene, syntheticTown, NoWebGPU } from '../../src/index';

declare global {
  interface Window { __mo?: { engine: Engine; ready: boolean; error?: string } }
}

const P = new URLSearchParams(location.search);

async function main(): Promise<void> {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const hud = document.getElementById('hud')!;
  const t0 = performance.now();
  const engine = await Engine.create({ canvas, pixelRatio: Number(P.get('dpr')) || undefined });
  console.log(`[demo] engine in ${(performance.now() - t0).toFixed(0)} ms`);
  const scene = P.get('scene') ? await loadMoScene(P.get('scene')!) : syntheticTown(Number(P.get('seed')) || 1103);
  const stats = engine.setScene(scene);
  const vp = Number(P.get('vp'));
  if (vp && scene.viewpoints.find((v) => v.id === vp)) engine.goTo(scene.viewpoints.find((v) => v.id === vp)!);
  addEventListener('keydown', (e) => {
    const n = /^Digit([1-9])$/.exec(e.code);
    if (n) { const v = scene.viewpoints[Number(n[1]) - 1]; if (v) engine.goTo(v); }
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
    hud.textContent = `${scene.name} · ${stats.instances} instances · ${(stats.triangles / 1e6).toFixed(1)} M tris (all at level 0+)\n` +
      `${(1000 / mean).toFixed(0)} fps · ${e.walker.mode} · ${p.map((x) => x.toFixed(0)).join(' ')}`;
  });
  engine.start();
  window.__mo = { engine, ready: true };
  console.log(`[demo] ready in ${(performance.now() - t0).toFixed(0)} ms`);
}

main().catch((e) => {
  console.error(e);
  window.__mo = { engine: undefined as unknown as Engine, ready: false, error: String(e?.message ?? e) };
  const err = document.getElementById('err')!;
  err.style.display = 'grid';
  err.textContent = e instanceof NoWebGPU ? 'This page needs WebGPU (Chrome, Edge, Safari 26 or Firefox on Windows).' : String(e?.message ?? e);
});
