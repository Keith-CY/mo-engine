// A page and one or more scenes as a static site (for Cloudflare Pages or any static host): the page at the root
// opening the first scene, each scene under scenes/<name>/ (cloned on APFS, so no space is taken), _headers caching
// the scene files for an hour. --page: an example (examples/<page>/: demo, the default, or linan, linan.lapla.si's
// interface, which opens scenes/linan-city/ by itself).
//
//   node tools/site.mjs --scene out/scenes/linan-city [--scene …] [--page demo] [--vp 2] [--out out/site]
//
// Run `npm run build` first. Every file stays ≤ 25 MiB (a Pages limit): pack a scene with tools/pack-scene.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
const first = path.basename(scenes[0]);
const vp = opt('vp', '');
let html = fs.readFileSync(path.join(ROOT, `examples/${PAGE}/index.html`), 'utf8');
if (PAGE === 'demo') html = html.replace('<script type="module"',
  `<script>{ const q = new URLSearchParams(location.search); if (!q.get('scene')) { q.set('scene', 'scenes/${first}/'); ` +
  `if (!q.get('vp') && '${vp}') q.set('vp', '${vp}'); history.replaceState(null, '', '?' + q); } }</script>\n<script type="module"`);
fs.writeFileSync(path.join(OUT, 'index.html'), html);
let files = 2, bytes = 0;
for (const dir of scenes) {
  const src = fs.realpathSync(dir), dst = path.join(OUT, 'scenes', path.basename(dir));
  fs.mkdirSync(dst);
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), st = fs.statSync(s);
    if (!st.isFile() || f === 'export-report.json') continue;
    if (st.size > LIMIT) throw new Error(`${s}: ${(st.size / 1048576).toFixed(1)} MiB (over 25 MiB: pack the scene first)`);
    try { execFileSync('cp', ['-c', s, path.join(dst, f)]); } catch { fs.copyFileSync(s, path.join(dst, f)); }
    files++; bytes += st.size;
  }
}
fs.writeFileSync(path.join(OUT, '_headers'), '/scenes/*\n  Cache-Control: public, max-age=3600\n');
console.log(`[site] ${OUT}: ${files} files, ${(bytes / 1048576).toFixed(0)} MB of scenes; opens scenes/${first}/`);
