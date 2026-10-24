// The watermark of linan.lapla.si (Keith-CY/linan src/explore/watermark.js, the page's part): a small red seal (印章)
// reading 杭 beside "lapla.si", faint, in the bottom-right corner, drawn in code (one SVG, system fonts). Day: a
// vermilion seal with a paper-white 杭, the name in ink, a faint paper halo; night (the moonlit look): a muted seal,
// the name in pale paper, a dark halo, a little fainter. ?wm=0 hides it.

/** geometry in CSS pixels */
const G = { seal: 18, glyph: 13.5, text: 12, gap: 6, right: 22, bottom: 18, w: 96, pad: 4 };
const OPACITY = { day: 0.3, night: 0.24 };
const COL = {
  day: { seal: '#a8321f', glyph: '#f4ead8', text: '#1d1b18', halo: '#eee8db', haloA: 0.9 },
  night: { seal: '#8e4436', glyph: '#e6dccb', text: '#e9e2d2', halo: '#10151e', haloA: 0.7 },
};
const SERIF = `'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC', 'SimSun', serif`;
const LATIN = `'Iowan Old Style', 'Palatino', 'Georgia', serif`;

/** the seal's outline: a square with slightly worn, uneven edges (fixed points: the same mark every time) */
function sealPath(x: number, y: number, s: number): string {
  const wob = [[0.18, 0.12], [0.43, -0.06], [0.71, 0.16], [0.9, 0.04]];
  const r = s * 0.07;
  const pts: number[][] = [];
  const edge = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number, w: number[][]) => {
    for (const [t, o] of w) pts.push([ax + (bx - ax) * t + nx * o, ay + (by - ay) * t + ny * o]);
  };
  pts.push([x + r, y]);
  edge(x, y, x + s, y, 0, 1, wob);
  pts.push([x + s - r, y]); pts.push([x + s, y + r]);
  edge(x + s, y, x + s, y + s, -1, 0, wob.map(([t, o]) => [t, o * 0.8]));
  pts.push([x + s, y + s - r]); pts.push([x + s - r, y + s]);
  edge(x + s, y + s, x, y + s, 0, -1, wob.map(([t, o]) => [t, -o * 0.6 + 0.05]));
  pts.push([x + r, y + s]); pts.push([x, y + s - r]);
  edge(x, y + s, x, y, 1, 0, wob.map(([t, o]) => [1 - t, o]));
  pts.push([x, y + r]);
  return 'M' + pts.map(([a, b]) => `${a.toFixed(2)} ${b.toFixed(2)}`).join('L') + 'Z';
}

function watermarkSVG(night: boolean): string {
  const c = night ? COL.night : COL.day;
  const W = G.w, H = G.seal + G.pad * 2, s = G.seal, x0 = W - G.pad - s, y0 = G.pad;
  const id = night ? 'n' : 'd';
  return `<svg class="${id}" xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>` +
    `<filter id="wmh${id}" x="-10%" y="-40%" width="120%" height="180%" color-interpolation-filters="sRGB">` +
    `<feMorphology in="SourceAlpha" operator="dilate" radius="0.8" result="d"/>` +
    `<feGaussianBlur in="d" stdDeviation="1.5" result="b"/>` +
    `<feFlood flood-color="${c.halo}" flood-opacity="${c.haloA}"/><feComposite in2="b" operator="in" result="h"/>` +
    `<feMerge><feMergeNode in="h"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `<filter id="wms${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/>` +
    `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.6 1.72" result="m"/>` +
    `<feComposite in="SourceGraphic" in2="m" operator="in"/></filter>` +
    `</defs>` +
    `<g filter="url(#wmh${id})">` +
    `<text x="${(x0 - G.gap).toFixed(2)}" y="${(y0 + s * 0.79).toFixed(2)}" text-anchor="end" font-family="${LATIN}" font-size="${G.text}" letter-spacing="0.7" fill="${c.text}">lapla.si</text>` +
    `<path d="${sealPath(x0, y0, s)}" fill="${c.seal}" filter="url(#wms${id})"/>` +
    `<text x="${(x0 + s / 2).toFixed(2)}" y="${(y0 + s * 0.5).toFixed(2)}" text-anchor="middle" dominant-baseline="central" font-family="${SERIF}" font-size="${G.glyph}" fill="${c.glyph}">杭</text>` +
    `</g></svg>`;
}

const CSS = `
.x-wm { position: absolute; z-index: 0; right: calc(max(${G.right}px, env(safe-area-inset-right)) - ${G.pad}px);
        bottom: calc(max(${G.bottom}px, env(safe-area-inset-bottom)) - ${G.pad}px); width: ${G.w}px; height: ${G.seal + G.pad * 2}px;
        pointer-events: none !important; opacity: ${OPACITY.day}; user-select: none; -webkit-user-select: none; }
.x-wm svg { display: block; width: 100%; height: 100%; }
.x-wm .n { display: none; }
.xui.night .x-wm { opacity: ${OPACITY.night}; }
.xui.night .x-wm .n { display: block; }
.xui.night .x-wm .d { display: none; }
`;

/** the page's mark, the first child of the interface root (so the menu panel and the hint draw over it) */
export function mountWatermark(parent: HTMLElement): void {
  if (new URLSearchParams(location.search).get('wm') === '0') return;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const el = document.createElement('div');
  el.className = 'x-wm';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = watermarkSVG(false) + watermarkSVG(true);
  parent.insertBefore(el, parent.firstChild);
}
