// Repack a mo-scene so no file passes a size (static hosts cap a file at 25 MiB): the geometry into several files
// (whole arrays, never split), every heightfield and class map into bands of rows (docs/SCENE_FORMAT.md, Large
// scenes). Everything else is copied as it is; a file that still passes the limit is reported.
//
//   node tools/pack-scene.mjs <scene dir> <out dir> [--max-mib 24]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const [SRC, OUT] = args.filter((a) => !a.startsWith('--'));
if (!SRC || !OUT) { console.error('node tools/pack-scene.mjs <scene dir> <out dir> [--max-mib 24]'); process.exit(2); }
const mi = args.indexOf('--max-mib');
const MAX = Math.floor((mi >= 0 ? Number(args[mi + 1]) : 24) * 1048576);
if (path.resolve(SRC) === path.resolve(OUT)) throw new Error('write the packed scene to another directory');

const j = JSON.parse(fs.readFileSync(path.join(SRC, 'scene.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
const written = new Map();

// ---- geometry: the arrays in the order they lie, a new file whenever the next one would pass the limit
const geoFiles = (j.geometry ?? ['geometry.bin']).map((f) => fs.readFileSync(path.join(SRC, f)));
const refs = [];
for (const m of j.meshes) { for (const a of Object.values(m.attributes)) refs.push(a); refs.push(m.index); }
const bytesOf = (ref, m) => {
  const per = { float32x3: 12, float32x2: 8, float32: 4, uint32: 4 }[ref.format];
  if (!per) throw new Error(`unknown format ${ref.format}`);
  return per * (ref === m.index ? m.indexCount : m.vertexCount);
};
const parts = [];
let cur = [], curBytes = 0;
const flush = () => { if (cur.length) { parts.push(Buffer.concat(cur)); cur = []; curBytes = 0; } };
for (const m of j.meshes) {
  for (const ref of [...Object.values(m.attributes), m.index]) {
    const n = bytesOf(ref, m);
    const src = geoFiles[ref.file ?? 0].subarray(ref.offset, ref.offset + n);
    if (curBytes && curBytes + n > MAX) flush();
    ref.file = parts.length; ref.offset = curBytes;
    cur.push(Buffer.from(src)); curBytes += n;
    const pad = (4 - (curBytes % 4)) % 4;
    if (pad) { cur.push(Buffer.alloc(pad)); curBytes += pad; }
  }
}
flush();
j.geometry = parts.map((_, k) => `geometry.${k}.bin`);
parts.forEach((b, k) => { fs.writeFileSync(path.join(OUT, j.geometry[k]), b); written.set(j.geometry[k], b.length); });

// ---- heightfields and class maps: bands of rows
const bandField = (f, stem, bytesPerSample) => {
  if (!f) return;
  const read = (file) => Array.isArray(file) ? Buffer.concat(file.map((x) => fs.readFileSync(path.join(SRC, x)))) : fs.readFileSync(path.join(SRC, file));
  const rows = Math.max(1, Math.floor(MAX / (f.width * bytesPerSample)));
  const bands = (buf, ext) => {
    const out = [];
    for (let r = 0, k = 0; r < f.depth; r += rows, k++) {
      const name = `${stem}.${k}.${ext}`;
      const b = buf.subarray(r * f.width * bytesPerSample, Math.min(f.depth, r + rows) * f.width * bytesPerSample);
      fs.writeFileSync(path.join(OUT, name), b); written.set(name, b.length); out.push(name);
    }
    return out;
  };
  const h = read(f.file);
  f.file = bands(h, 'f32'); f.rowsPerFile = rows;
  if (f.classMap) { const c = read(f.classMap.file); f.classMap = { ...f.classMap, file: (() => { const r0 = rows; const out = []; for (let r = 0, k = 0; r < f.depth; r += r0, k++) { const name = `${stem}.cls.${k}.u8`; const b = c.subarray(r * f.width, Math.min(f.depth, r + r0) * f.width); fs.writeFileSync(path.join(OUT, name), b); written.set(name, b.length); out.push(name); } return out; })() }; }
};
bandField(j.terrain?.near, 'terrain-near', 4);
bandField(j.terrain?.far, 'terrain-far', 4);

// ---- the rest as it is
for (const f of ['instances.bin', ...(j.textures ?? []).map((t) => t.file)]) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f)); written.set(f, fs.statSync(path.join(OUT, f)).size);
}
fs.writeFileSync(path.join(OUT, 'scene.json'), JSON.stringify(j, null, 1));
written.set('scene.json', fs.statSync(path.join(OUT, 'scene.json')).size);

const over = [...written].filter(([, n]) => n > MAX);
const total = [...written.values()].reduce((a, b) => a + b, 0);
console.log(`[pack] ${written.size} files, ${(total / 1048576).toFixed(1)} MiB, largest ${(Math.max(...written.values()) / 1048576).toFixed(1)} MiB${over.length ? `; OVER ${MAX / 1048576} MiB: ${over.map(([f, n]) => `${f} ${(n / 1048576).toFixed(1)}`).join(', ')}` : ''}`);
if (over.length) process.exitCode = 1;
