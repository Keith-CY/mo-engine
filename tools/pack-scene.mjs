// Repack a mo-scene so no file passes a size (static hosts cap a file at 25 MiB): the geometry into several files
// (whole arrays, never split), every heightfield and class map into bands of rows (docs/SCENE_FORMAT.md, Large
// scenes). Everything else is copied as it is; a file that still passes the limit is reported. For the web
// (docs/SCENE_FORMAT.md, Packed scenes):
//   --compact  the arrays in small formats (positions and uv quantized to 16 bits over the mesh's own range, normals
//              octahedral in 2 × 16 bits, paint values as half floats, classes, patterns and indices in the fewest
//              bytes, heights in 16 bits over the field's range), each stored component by component as the
//              differences from one value to the next (what gzip packs best); identical arrays stored once; meshes no
//              batch or level draws left empty
//   --gzip     every binary file gzipped (name.gz: the loader inflates it)
//   --lazy     the levels of a one-instance LOD group (a building) other than its last, where a level holds more than
//              --lazy-kib, each mesh in a file of its own that the engine fetches when the eye comes near
//              (geometryLazy); the group draws its next level until then
//
//   node tools/pack-scene.mjs <scene dir> <out dir> [--max-mib 24] [--compact] [--gzip] [--lazy [--lazy-kib 512]]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const [SRC, OUT] = args.filter((a, i) => !a.startsWith('--') && !['--max-mib', '--lazy-kib'].includes(args[i - 1]));
if (!SRC || !OUT) { console.error('node tools/pack-scene.mjs <scene dir> <out dir> [--max-mib 24] [--compact] [--gzip] [--lazy [--lazy-kib 512]]'); process.exit(2); }
const num = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const MAX = Math.floor(num('--max-mib', 24) * 1048576);
const COMPACT = args.includes('--compact'), GZIP = args.includes('--gzip'), LAZY = args.includes('--lazy');
const LAZY_MIN = num('--lazy-kib', 512) * 1024;
if (path.resolve(SRC) === path.resolve(OUT)) throw new Error('write the packed scene to another directory');

const j = JSON.parse(fs.readFileSync(path.join(SRC, 'scene.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
const written = new Map();
let rawTotal = 0;
const write = (name, buf) => {
  rawTotal += buf.length;
  const b = GZIP ? zlib.gzipSync(buf, { level: 9 }) : buf;
  const f = GZIP ? name + '.gz' : name;
  fs.writeFileSync(path.join(OUT, f), b); written.set(f, b.length);
  return f;
};

// ---- the arrays' encodings
const PER = { float32x3: 12, float32x2: 8, float32x4: 16, float32: 4, uint32: 4 };
const f32 = (b) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
const u32 = (b) => new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4);
const range = (a, c) => {
  const lo = Array(c).fill(Infinity), hi = Array(c).fill(-Infinity);
  for (let i = 0; i < a.length; i++) { const k = i % c; if (a[i] < lo[k]) lo[k] = a[i]; if (a[i] > hi[k]) hi[k] = a[i]; }
  return [lo.map((x) => (Number.isFinite(x) ? x : 0)), hi.map((x) => (Number.isFinite(x) ? x : 0))];
};
/** values quantized to 16 bits over each component's range → (bytes, min, max) */
const unorm16 = (a, c) => {
  const [lo, hi] = range(a, c);
  const q = new Uint16Array(a.length);
  for (let i = 0; i < a.length; i++) { const k = i % c, d = hi[k] - lo[k]; q[i] = d > 0 ? Math.round(((a[i] - lo[k]) / d) * 65535) : 0; }
  return { bytes: Buffer.from(q.buffer), min: lo, max: hi };
};
const octSnorm16 = (a) => {
  const q = new Int16Array((a.length / 3) * 2);
  for (let i = 0, o = 0; i < a.length; i += 3, o += 2) {
    let x = a[i], y = a[i + 1], z = a[i + 2];
    const l = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
    x /= l; y /= l; z /= l;
    if (z < 0) { const ox = x; x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1); y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1); }
    q[o] = Math.round(Math.max(-1, Math.min(1, x)) * 32767); q[o + 1] = Math.round(Math.max(-1, Math.min(1, y)) * 32767);
  }
  return Buffer.from(q.buffer);
};
const half = (() => {
  const F = new Float32Array(1), I = new Uint32Array(F.buffer);
  return (v) => {
    F[0] = v; const x = I[0], s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
    if (e <= 0) return s | (e < -10 ? 0 : (((m | 0x800000) >> (1 - e)) + 0x1000) >> 13);
    if (e >= 31) return s | 0x7c00 | (((x >>> 23) & 0xff) === 0xff && m ? 0x200 : 0);
    const h = s | (e << 10) | (m >> 13);
    return (m & 0x1000) ? h + 1 : h;   // (round half up; a carry into the exponent is still the right value)
  };
})();
const float16 = (a) => { const q = new Uint16Array(a.length); for (let i = 0; i < a.length; i++) q[i] = half(a[i]); return Buffer.from(q.buffer); };
/** an integer array of c components stored component by component, each value as its difference from the one before
 *  (modulo the type's range: the loader adds them up again) */
const deltaPlanar = (a, c) => {
  const n = a.length / c, out = new a.constructor(a.length);
  for (let k = 0; k < c; k++) {
    let prev = 0;
    for (let i = 0; i < n; i++) { const v = a[i * c + k]; out[k * n + i] = v - prev; prev = v; }
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
};
const asU16 = (b) => new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2);
const narrow = (a, max) => {
  if (max < 256) return { bytes: Buffer.from(Uint8Array.from(a).buffer), format: 'uint8' };
  if (max < 65536) return { bytes: Buffer.from(Uint16Array.from(a).buffer), format: 'uint16' };
  return { bytes: Buffer.from(a.buffer, a.byteOffset, a.byteLength), format: 'uint32' };
};
/** one array in its packed form → { bytes, ref fields } */
const encode = (kind, src, m) => {
  if (!COMPACT) return { bytes: src, fields: {} };
  const d = (b, c, fields) => ({ bytes: deltaPlanar(asU16(b), c), fields: { ...fields, delta: true } });
  if (kind === 'position') { const e = unorm16(f32(src), 3); return d(e.bytes, 3, { format: 'unorm16x3', min: e.min, max: e.max }); }
  if (kind === 'uv') { const e = unorm16(f32(src), 2); return d(e.bytes, 2, { format: 'unorm16x2', min: e.min, max: e.max }); }
  if (kind === 'tone') { const e = unorm16(f32(src), 1); return d(e.bytes, 1, { format: 'unorm16', min: e.min, max: e.max }); }
  if (kind === 'normal') return d(octSnorm16(f32(src)), 2, { format: 'snorm16x2oct' });
  if (kind === 'paint') return d(float16(f32(src)), 4, { format: 'float16x4' });
  // classes, patterns, indices: the fewest bytes that hold them
  const a = u32(src);
  let max = 0; for (let i = 0; i < a.length; i++) if (a[i] > max) max = a[i];
  if (kind === 'index') max = Math.max(max, m.vertexCount - 1);
  const n = narrow(a, max);
  const t = { uint8: Uint8Array, uint16: Uint16Array, uint32: Uint32Array }[n.format];
  return { bytes: deltaPlanar(new t(n.bytes.buffer, n.bytes.byteOffset, n.bytes.byteLength / t.BYTES_PER_ELEMENT), 1), fields: { format: n.format, delta: true } };
};

// ---- which meshes wait: every mesh of a non-last level of a one-instance group, unless a level that is loaded
// at the start shares it (or the level is small)
const geoFiles = (j.geometry ?? ['geometry.bin']).map((f) => fs.readFileSync(path.join(SRC, f)));
const levelMeshes = (l) => (l.meshes ?? (l.mesh !== undefined ? [l.mesh] : []));
const arrays = (m) => [...Object.entries(m.attributes), ['index', m.index]];
const srcBytes = (kind, ref, m) => {
  const per = PER[ref.format];
  if (!per) throw new Error(`unknown format ${ref.format}`);
  const n = per * (kind === 'index' ? m.indexCount : m.vertexCount);
  return geoFiles[ref.file ?? 0].subarray(ref.offset, ref.offset + n);
};
const meshBytes = (m) => arrays(m).reduce((s, [k, r]) => s + srcBytes(k, r, m).length, 0);
const lazyMesh = new Set();
if (LAZY) {
  const single = new Set(j.batches.filter((b) => b.lodGroup !== undefined && b.count === 1).map((b) => b.lodGroup));
  const eager = new Set();
  j.lodGroups.forEach((g, gi) => g.levels.forEach((l, li) => {
    const ms = levelMeshes(l);
    const lazyLevel = single.has(gi) && li < g.levels.length - 1 && ms.reduce((s, mi) => s + meshBytes(j.meshes[mi]), 0) > LAZY_MIN;
    for (const mi of ms) (lazyLevel ? lazyMesh : eager).add(mi);
  }));
  for (const b of j.batches) if (b.mesh !== undefined) eager.add(b.mesh);
  for (const mi of eager) lazyMesh.delete(mi);
}
// (a mesh nothing draws — a level's old copy left in the export — is left empty)
const drawn = new Set(j.batches.filter((b) => b.mesh !== undefined).map((b) => b.mesh));
for (const g of j.lodGroups ?? []) for (const l of g.levels) for (const mi of levelMeshes(l)) drawn.add(mi);
let dropped = 0;
j.meshes.forEach((m, mi) => {
  if (drawn.has(mi) || !COMPACT) return;
  dropped++;
  m.vertexCount = 0; m.indexCount = 0;
  m.attributes = { position: m.attributes.position, normal: m.attributes.normal };
});

// ---- geometry: the arrays in the order they lie, a new file whenever the next one would pass the limit; the
// waiting meshes one file each; identical arrays (once encoded) stored once
const parts = [];
let cur = [], curBytes = 0;
const flush = () => { if (cur.length) { parts.push(Buffer.concat(cur)); cur = []; curBytes = 0; } };
const seen = new Map();
const lazyFiles = [];
let shared = 0;
for (const [mi, m] of j.meshes.entries()) {
  const lazy = lazyMesh.has(mi);
  const lz = lazy ? { bufs: [], n: 0 } : null;
  for (const [kind, ref] of arrays(m)) {
    const e = encode(kind, srcBytes(kind, ref, m), m);
    delete ref.file; delete ref.offset;
    Object.assign(ref, e.fields);
    if (lazy) {
      ref.lazy = lazyFiles.length; ref.offset = lz.n;
      lz.bufs.push(e.bytes); lz.n += e.bytes.length;
      const pad = (4 - (lz.n % 4)) % 4;
      if (pad) { lz.bufs.push(Buffer.alloc(pad)); lz.n += pad; }
      continue;
    }
    const key = crypto.createHash('sha1').update(e.bytes).update(JSON.stringify(e.fields)).digest('hex');
    const hit = seen.get(key);
    if (hit) { ref.file = hit.file; ref.offset = hit.offset; shared += e.bytes.length; continue; }
    if (curBytes && curBytes + e.bytes.length > MAX) flush();
    ref.file = parts.length; ref.offset = curBytes;
    seen.set(key, { file: ref.file, offset: ref.offset });
    cur.push(e.bytes); curBytes += e.bytes.length;
    const pad = (4 - (curBytes % 4)) % 4;
    if (pad) { cur.push(Buffer.alloc(pad)); curBytes += pad; }
  }
  if (lazy) lazyFiles.push(Buffer.concat(lz.bufs));
}
flush();
j.geometry = parts.map((b, k) => write(`geometry.${k}.bin`, b));
if (lazyFiles.length) j.geometryLazy = lazyFiles.map((b, k) => write(`lazy.${k}.bin`, b));
else delete j.geometryLazy;

// ---- heightfields and class maps: bands of rows (heights in 16 bits over the field's range when compact)
const bandField = (f, stem) => {
  if (!f) return;
  const read = (file) => Array.isArray(file) ? Buffer.concat(file.map((x) => fs.readFileSync(path.join(SRC, x)))) : fs.readFileSync(path.join(SRC, file));
  let h = read(f.file), per = 4, ext = 'f32';
  if (COMPACT && (f.format ?? 'float32') === 'float32') {
    const e = unorm16(f32(h), 1);
    h = e.bytes; per = 2; ext = 'u16'; f.format = 'unorm16'; f.min = e.min[0]; f.max = e.max[0]; f.delta = true;
  }
  const rows = Math.max(1, Math.floor(MAX / (f.width * per)));
  // (each band its own run of differences: a band is decoded on its own)
  const enc = (b) => (f.delta && b !== undefined ? deltaPlanar(asU16(b), 1) : b);
  const bands = (buf, bpp, name, code = (b) => b) => {
    const out = [];
    for (let r = 0, k = 0; r < f.depth; r += rows, k++) out.push(write(name(k), code(Buffer.from(buf.subarray(r * f.width * bpp, Math.min(f.depth, r + rows) * f.width * bpp)))));
    return out;
  };
  f.file = bands(h, per, (k) => `${stem}.${k}.${ext}`, enc); f.rowsPerFile = rows;
  if (f.classMap) f.classMap = { ...f.classMap, file: bands(read(f.classMap.file), 1, (k) => `${stem}.cls.${k}.u8`) };
};
bandField(j.terrain?.near, 'terrain-near');
bandField(j.terrain?.far, 'terrain-far');

// ---- the rest as it is (gzipped when asked)
if (j.instanceFiles?.length) j.instanceFiles = j.instanceFiles.map((f) => write(f, fs.readFileSync(path.join(SRC, f))));
else j.instanceFile = write('instances.bin', fs.readFileSync(path.join(SRC, j.instanceFile ?? 'instances.bin')));
for (const t of j.textures ?? []) t.file = write(t.file, fs.readFileSync(path.join(SRC, t.file)));
if (j.surfaces) { fs.copyFileSync(path.join(SRC, j.surfaces), path.join(OUT, j.surfaces)); written.set(j.surfaces, fs.statSync(path.join(OUT, j.surfaces)).size); }
fs.writeFileSync(path.join(OUT, 'scene.json'), JSON.stringify(j));
written.set('scene.json', fs.statSync(path.join(OUT, 'scene.json')).size);

const over = [...written].filter(([, n]) => n > MAX);
const sum = (list) => list.reduce((a, f) => a + (written.get(f) ?? 0), 0);
const total = [...written.values()].reduce((a, b) => a + b, 0);
const lazyBytes = sum(j.geometryLazy ?? []);
console.log(`[pack] ${written.size} files, ${(total / 1048576).toFixed(1)} MiB (${(rawTotal / 1048576).toFixed(0)} MiB before gzip; ${(shared / 1048576).toFixed(0)} MiB of arrays shared; ${dropped} meshes nothing draws left empty)` +
  `${lazyFiles.length ? `; at the start ${((total - lazyBytes) / 1048576).toFixed(1)} MiB, when near ${lazyFiles.length} meshes ${(lazyBytes / 1048576).toFixed(1)} MiB` : ''}` +
  `; largest ${(Math.max(...written.values()) / 1048576).toFixed(1)} MiB${over.length ? `; OVER ${MAX / 1048576} MiB: ${over.map(([f, n]) => `${f} ${(n / 1048576).toFixed(1)}`).join(', ')}` : ''}`);
if (over.length) process.exitCode = 1;
