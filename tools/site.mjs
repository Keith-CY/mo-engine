// A page and one or more scenes as a static site (for Cloudflare Pages or any static host): the page at the root
// opening the first scene, each scene under scenes/<name>.<hash>/ (cloned on APFS, so no space is taken) — the hash of
// its files, so a new deploy never shares a URL with an older one: an edge or a browser holding the old files cannot
// mix them with the new scene.json (it did, 10-25: the city half old, half new, broken). The scene files are cached
// for a year (immutable), the page and its module revalidated every time. --page: an example (examples/<page>/: demo,
// the default, or linan, linan.lapla.si's interface, told its scene by a <meta name="mo-scene">).
//
//   node tools/site.mjs --scene out/scenes/linan-city [--scene …] [--page demo] [--vp 2] [--out out/site]
//
// Run `npm run build` first. Every file stays ≤ 25 MiB (a Pages limit): pack a scene with tools/pack-scene.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const scenes = argv.flatMap((a, i) => (a === '--scene' ? [path.resolve(argv[i + 1])] : []));
if (!scenes.length) { console.error('node tools/site.mjs --scene <dir> [--scene …] [--vp 2] [--out out/site]'); process.exit(2); }
const OUT = path.resolve(opt('out', 'out/site'));
const LIMIT = 25 * 1024 * 1024;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'scenes'), { recursive: true });
const PAGE = opt('page', 'demo');
fs.copyFileSync(path.join(ROOT, `examples/${PAGE}/main.js`), path.join(OUT, 'main.js'));
/** a scene's folder name: its name and the hash of its files */
const named = (dir) => {
  const src = fs.realpathSync(dir), h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(src).sort()) {
    const s = path.join(src, f);
    if (fs.statSync(s).isFile() && f !== 'export-report.json') { h.update(f); h.update(fs.readFileSync(s)); }
  }
  return `${path.basename(dir)}.${h.digest('hex').slice(0, 10)}`;
};
const names = scenes.map(named);
const first = names[0];
const vp = opt('vp', '');
let html = fs.readFileSync(path.join(ROOT, `examples/${PAGE}/index.html`), 'utf8');
if (PAGE === 'demo') html = html.replace('<script type="module"',
  `<script>{ const q = new URLSearchParams(location.search); if (!q.get('scene')) { q.set('scene', 'scenes/${first}/'); ` +
  `if (!q.get('vp') && '${vp}') q.set('vp', '${vp}'); history.replaceState(null, '', '?' + q); } }</script>\n<script type="module"`);
else html = html.replace('</head>', `<meta name="mo-scene" content="scenes/${first}/">\n</head>`);
fs.writeFileSync(path.join(OUT, 'index.html'), html);
// The page's /llms.txt (llmstxt.org), when it has one (examples/linan/llms.txt).
const llms = path.join(ROOT, `examples/${PAGE}/llms.txt`);
if (fs.existsSync(llms)) fs.copyFileSync(llms, path.join(OUT, 'llms.txt'));
let files = 2, bytes = 0;
for (const [k, dir] of scenes.entries()) {
  const src = fs.realpathSync(dir), dst = path.join(OUT, 'scenes', names[k]);
  fs.mkdirSync(dst);
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), st = fs.statSync(s);
    if (!st.isFile() || f === 'export-report.json') continue;
    if (st.size > LIMIT) throw new Error(`${s}: ${(st.size / 1048576).toFixed(1)} MiB (over 25 MiB: pack the scene first)`);
    try { execFileSync('cp', ['-c', s, path.join(dst, f)]); } catch { fs.copyFileSync(s, path.join(dst, f)); }
    files++; bytes += st.size;
  }
}
fs.writeFileSync(path.join(OUT, '_headers'), '/scenes/*\n  Cache-Control: public, max-age=31536000, immutable\n' +
  '/\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n/main.js\n  Cache-Control: no-cache\n');
console.log(`[site] ${OUT}: ${files} files, ${(bytes / 1048576).toFixed(0)} MB of scenes; opens scenes/${first}/`);
