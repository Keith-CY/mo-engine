// 临安 (linan.lapla.si) on the Mo engine: the city exported from Keith-CY/linan (?scene=, default scenes/linan-city/),
// painted by painter 2, with linan's interface — the loading screen, the title, the places and the times of day in the
// menu at the top right, walk / fly, the place's name after a jump, a short help line and the watermark.
//   1 – 0  places · T  next time · M  the menu · F  walk / fly · W A S D or arrows, Shift, Space / E, C / Q · drag or
//   double-click to look · H  the HUD; touch: a stick on the left, look on the right, up / down buttons while flying
// ?vp= (or linan's ?at=) the first place (default 2) · ?fps=1 the frame rate · ?menu=1 the menu open · ?ui=0 none · ?adaptive=1 the
// render scale follows the frame rate under automation too · ?scale=, ?p2dbg=, ?hud=1 as the demo's
import { Engine, loadMoScene, NoWebGPU, type Viewpoint } from '../../src/index';
import { mountWatermark } from './watermark';

declare global {
  interface Window { __mo?: { engine: Engine; ready: boolean; error?: string; go?: (id: number) => void } }
}

/** the places (linan src/explore/ui.js PLACES): a viewpoint's names, and where its name stands after a jump */
const PLACES: Record<number, { zh: string; en: string; title?: { left?: string; top?: string } }> = {
  1: { zh: '西湖全景', en: 'West Lake from Baoshi Hill' },
  2: { zh: '苏堤春晓', en: 'Su Causeway at Dawn' },
  3: { zh: '曲院风荷', en: 'Lotus at Quyuan' },
  4: { zh: '雷峰夕照', en: 'Leifeng Pagoda at Sunset', title: { left: '62%' } },
  5: { zh: '三潭印月', en: 'Three Pools Mirroring the Moon' },
  6: { zh: '南宋皇城', en: 'The Imperial Palace' },
  7: { zh: '临安御街', en: 'The Imperial Way' },
  8: { zh: '飞来峰', en: 'Feilai Peak and Lingyin', title: { left: '47%', top: '7%' } },
  9: { zh: '六和塔', en: 'Liuhe Pagoda and the Tide' },
  10: { zh: '断桥残雪', en: 'Broken Bridge in Snow' },
};
/** the looks offered as times and seasons (linan TIMES: look id = the place that defines it) */
const TIMES = [
  { look: 2, zh: '春晓', en: 'Spring dawn' }, { look: 3, zh: '夏午', en: 'Summer noon' }, { look: 4, zh: '夕照', en: 'Sunset' },
  { look: 5, zh: '月夜', en: 'Moonlit night' }, { look: 8, zh: '秋', en: 'Autumn' }, { look: 10, zh: '冬雪', en: 'Winter snow' },
];
const NIGHT_LOOK = 5;
/** linan's looks restyled toward the reference paintings the owner picked (Keith-CY/linan refs/ink01–10), over the
 *  settings its stills were painted with: a bluer summer sky and more heaps of cloud, the sunset's lake pale with the
 *  woods dark in it (not a dark wash), its woods veiled only high up, the bore's sky full of cumulus */
const REF_INK: Record<number, Record<string, unknown>> = {
  1: { bands: [[330, 210, 0.35, 48], [3700, 900, 0.95, 70], [9000, 4500, 0.9, 300]] },
  3: { skyTint: [0.95, 0.55, 0.28, 0.42], clouds: 0.7 },
  4: { water: 0.12, veil: [40, 90, 0.5], leaf: 0.8, haze: 700 },
  6: { veil: [68, 100, 0.35], mist: [5, 34, 140, 0.4] },
  9: { clouds: 0.75 },
};

const P = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function loading(f: number, zh: string, en: string, right: string): void {
  $('ld-bar').style.transform = `scaleX(${Math.max(0.02, Math.min(1, f)).toFixed(3)})`;
  $('ld-step').innerHTML = `${zh}<span>${en}</span>`;
  $('ld-pc').textContent = right;
}

class UI {
  readonly root: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly placeEl: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly stickEl: HTMLElement;
  readonly touch = matchMedia('(pointer: coarse)').matches;
  /** up / down from the buttons shown while flying on a touch screen */
  lift = 0;
  constructor(places: Viewpoint[], on: { place: (id: number) => void; time: (look: number) => void; mode: (m: 'walk' | 'fly') => void }) {
    const root = (this.root = document.createElement('div'));
    root.className = 'xui';
    root.innerHTML = `
      <div class="x-title"><b>临安</b><span>Lin’an · Southern Song Hangzhou</span></div>
      <button class="x-menu-btn" aria-label="Places and times" aria-expanded="false">景 <span>Places</span></button>
      <div class="x-panel" role="dialog" aria-label="Places and times">
        <div class="x-sec"><h3>名胜 <span>Places</span></h3><ol class="x-places"></ol></div>
        <div class="x-sec"><h3>时令 <span>Time and season</span></h3><div class="x-times"></div></div>
        <div class="x-sec"><div class="x-modes"><button data-m="walk">步行 <span>Walk</span></button><button data-m="fly">飞行 <span>Fly</span></button></div></div>
        <p class="x-keys"></p>
      </div>
      <div class="x-hint"></div>
      <div class="x-place" aria-live="polite"></div>
      <div class="x-fly"><button data-l="1" aria-label="Up">升</button><button data-l="-1" aria-label="Down">降</button></div>
      <div class="x-stick" aria-hidden="true"><i></i></div>
      <div class="x-loading">细部载入中<span>Loading detail</span></div>`;
    document.body.appendChild(root);
    root.classList.toggle('touch', this.touch);
    mountWatermark(root);
    root.querySelector('.x-keys')!.innerHTML = this.touch
      ? '左手推动行走，推到边缘为跑 · 右手拖动环顾<br><span>Left thumb to walk, push to the rim to run · drag on the right to look around</span>'
      : 'WASD 行走 · 拖动环顾 · Shift 跑 · F 飞行 · 1–0 名胜 · T 时令 · M 菜单<br><span>WASD walk · drag to look · Shift run · F fly · 1–0 places · T time · M menu</span>';
    for (const b of root.querySelectorAll<HTMLElement>('.x-fly button')) {
      const l = Number(b.dataset.l);
      b.addEventListener('touchstart', (e) => { e.preventDefault(); this.lift = l; }, { passive: false });
      b.addEventListener('touchend', () => { this.lift = 0; });
      b.addEventListener('touchcancel', () => { this.lift = 0; });
    }
    this.stickEl = root.querySelector('.x-stick')!;
    const ol = root.querySelector('.x-places')!;
    places.forEach((v, i) => {
      const p = PLACES[v.id] ?? { zh: v.name, en: '' };
      const li = document.createElement('li');
      li.style.setProperty('--i', String(i));
      li.innerHTML = `<button data-p="${v.id}"><em>${v.id % 10}</em>${p.zh}<span>${p.en}</span></button>`;
      ol.appendChild(li);
    });
    const tm = root.querySelector('.x-times')!;
    for (const t of TIMES) { const b = document.createElement('button'); b.dataset.t = String(t.look); b.innerHTML = `${t.zh}<span>${t.en}</span>`; tm.appendChild(b); }
    const btn = root.querySelector<HTMLButtonElement>('.x-menu-btn')!;
    btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    root.querySelector('.x-panel')!.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = (e.target as HTMLElement).closest('button'); if (!b) return;
      if (b.dataset.p) { on.place(Number(b.dataset.p)); this.toggle(false); }
      else if (b.dataset.t) on.time(Number(b.dataset.t));
      else if (b.dataset.m) on.mode(b.dataset.m as 'walk' | 'fly');
    });
    // a click on the painting closes the menu
    addEventListener('mousedown', (e) => { if (this.open && !(e.target as HTMLElement).closest('.x-panel, .x-menu-btn')) this.toggle(false); });
    this.hint = root.querySelector('.x-hint')!;
    this.placeEl = root.querySelector('.x-place')!;
    this.detail = root.querySelector('.x-loading')!;
    this.setLocked(false);
  }
  get open(): boolean { return this.root.classList.contains('open'); }
  toggle(open = !this.open): void {
    this.root.classList.toggle('open', open);
    this.root.querySelector('.x-menu-btn')!.setAttribute('aria-expanded', String(open));
    if (open && document.pointerLockElement) document.exitPointerLock();
  }
  setLocked(locked: boolean): void {
    this.hint.innerHTML = this.touch ? '左侧拖动行走 · 右侧拖动环顾 <span>Drag left to walk · drag right to look</span>'
      : locked ? 'Esc 释放鼠标 <span>Esc to free the mouse</span>' : '拖动画面环顾 · 双击锁定鼠标 · WASD 行走 <span>Drag to look around · double-click to lock the mouse · WASD to walk</span>';
  }
  /** the touch stick under the thumb (null: let go) */
  stick(s: { x: number; y: number; dx: number; dy: number } | null): void {
    this.stickEl.classList.toggle('on', !!s);
    if (!s) { (this.stickEl.firstElementChild as HTMLElement).style.transform = ''; return; }
    this.stickEl.style.left = `${s.x}px`; this.stickEl.style.top = `${s.y}px`;
    (this.stickEl.firstElementChild as HTMLElement).style.transform = `translate(${s.dx}px, ${s.dy}px)`;
  }
  setState(s: { place: number; look: number; mode: string }): void {
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-p]')) b.classList.toggle('on', Number(b.dataset.p) === s.place);
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-t]')) b.classList.toggle('on', Number(b.dataset.t) === s.look);
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-m]')) b.classList.toggle('on', b.dataset.m === s.mode);
    this.root.classList.toggle('night', s.look === NIGHT_LOOK);
    this.root.classList.toggle('flying', s.mode === 'fly');
  }
  /** a place's name that fades in and out after a jump (where its painting leaves room for it) */
  announce(id: number): void {
    const p = PLACES[id]; if (!p) return;
    this.placeEl.innerHTML = `${p.zh}<span>${p.en}</span>`;
    const t = innerWidth > 560 && p.title ? p.title : {};
    this.placeEl.style.left = t.left ?? ''; this.placeEl.style.top = t.top ?? '';
    this.placeEl.classList.remove('show'); void this.placeEl.offsetWidth; this.placeEl.classList.add('show');
  }
  /** the finer levels near the eye on their way (shown only when it takes a while) */
  setStreaming(on: boolean): void { this.detail.classList.toggle('on', on); }
}

async function main(): Promise<void> {
  const canvas = $<HTMLCanvasElement>('c');
  const hud = $('hud');
  if (P.get('hud') === '1') hud.hidden = false;
  const t0 = performance.now();
  loading(0.02, '展卷', 'Unrolling the scroll', '');
  const engine = await Engine.create({ canvas, pixelRatio: Number(P.get('dpr')) || undefined });
  const src = P.get('scene') ?? 'scenes/linan-city/';
  const scene = await loadMoScene(src, {
    onProgress: (done, total, bytes) => loading(0.05 + 0.85 * (done / total), '展卷', 'Unrolling the scroll', `${(bytes / 1048576).toFixed(0)} MB`),
  });
  loading(0.93, '研墨', 'Grinding the ink', '');
  engine.renderer.painter = P.get('p2') === '0' ? 1 : 2;
  if (navigator.webdriver && P.get('adaptive') !== '1') engine.adaptive = false;
  if (P.get('scale')) { engine.adaptive = false; engine.renderScale = Number(P.get('scale')); engine.resize(); }
  if (P.get('p2dbg')) engine.renderer.p2.debug = Number(P.get('p2dbg'));
  // every level-of-detail distance at 0.8 (a fifth fewer triangles where the woods are thick, as at 飞来峰, with no
  // difference the painting shows); ?lod= another scale
  engine.renderer.lodScale = Number(P.get('lod') ?? 0.8);
  for (const L of scene.looks ?? []) if (REF_INK[L.id] && P.get('refink') !== '0') L.ink = { ...(L.ink ?? {}), ...REF_INK[L.id] };
  engine.setScene(scene);

  const vps = scene.viewpoints;
  const byId = (id: number) => vps.find((v) => v.id === id);
  let place = Number(P.get('vp') ?? P.get('at') ?? 2);
  if (!byId(place)) place = vps[0]?.id ?? 0;
  const state = () => ({ place, look: engine.look?.id ?? -1, mode: engine.walker.mode });
  const ui = new UI(vps, {
    place: (id) => go(id),
    time: (look) => { engine.setLook(look); ui.setState(state()); },
    mode: (m) => { engine.walker.mode = m; ui.setState(state()); },
  });
  const go = (id: number, announce = true) => {
    const v = byId(id); if (!v) return;
    place = id;
    engine.goTo(v);
    ui.setState(state());
    if (announce) ui.announce(id);
  };
  go(place, false);
  if (P.get('look')) engine.setLook(Number(P.get('look')));
  if (P.get('menu') === '1') ui.toggle(true);
  if (P.get('ui') === '0') ui.root.style.display = 'none';

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = /^Digit([0-9])$/.exec(e.code);
    if (n) { const v = vps[(Number(n[1]) + 9) % 10]; if (v) go(v.id); }
    else if (e.code === 'KeyT') {
      const i = TIMES.findIndex((t) => t.look === engine.look?.id);
      engine.setLook(TIMES[(i + 1) % TIMES.length].look); ui.setState(state());
    } else if (e.code === 'KeyM') ui.toggle();
    else if (e.code === 'Escape' && ui.open) ui.toggle(false);
    else if (e.code === 'KeyH') hud.hidden = !hud.hidden;
    else if (e.code === 'KeyF') requestAnimationFrame(() => ui.setState(state()));   // (the walker switches on the same key)
  });
  document.addEventListener('pointerlockchange', () => ui.setLocked(document.pointerLockElement === canvas));
  engine.walker.onStick = (st) => ui.stick(st);

  const fpsOn = P.get('fps') === '1';
  if (fpsOn) hud.hidden = false;
  let last = 0;
  engine.onFrame((e) => {
    const now = performance.now();
    e.walker.lift = ui.lift;
    // (the finer levels' note only when they take more than a moment: the CSS waits 0.6 s before showing it)
    ui.setStreaming(e.renderer.streaming > 0);
    if (now - last < 500 || hud.hidden) return;
    last = now;
    const ft = e.frameTimes.slice(-120);
    const mean = ft.reduce((a, b) => a + b, 0) / Math.max(1, ft.length);
    const p = e.camera.position;
    hud.textContent = `${(1000 / mean).toFixed(0)} fps · scale ${e.renderScale} · ${e.walker.mode} · ${p.map((x) => x.toFixed(0)).join(' ')}` +
      (fpsOn ? '' : `\n${e.look?.name ?? ''} · levels on their way ${e.renderer.streaming}`);
  });
  engine.start();
  // the painting shows once its first frames are drawn
  await new Promise((r) => setTimeout(r, 120));
  loading(1, '研墨', 'Grinding the ink', '');
  $('loading').classList.add('gone');
  setTimeout(() => $('loading').remove(), 600);
  window.__mo = { engine, ready: true, go: (id: number) => go(id, false) };
  console.log(`[linan] ready in ${(performance.now() - t0).toFixed(0)} ms`);
}

main().catch((e) => {
  console.error(e);
  window.__mo = { engine: undefined as unknown as Engine, ready: false, error: String(e?.message ?? e) };
  const l = $('loading');
  l.classList.add('error');
  $('ld-note').textContent = e instanceof NoWebGPU
    ? '这一页需要 WebGPU：请用电脑上的 Chrome、Edge 或 Safari 打开。 This page needs WebGPU: open it in desktop Chrome, Edge or Safari.'
    : String(e?.message ?? e);
});
