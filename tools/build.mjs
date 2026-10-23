// Bundles the library (dist/mo.js, one ES module with its shaders inlined) and the examples (examples/*/main.ts →
// examples/*/main.js). node tools/build.mjs [--watch]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const common = { bundle: true, format: 'esm', target: 'es2022', loader: { '.wgsl': 'text' }, sourcemap: true, logLevel: 'info' };
const examples = fs.readdirSync(path.join(ROOT, 'examples'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, 'examples', d.name, 'main.ts')))
  .map((d) => path.join(ROOT, 'examples', d.name, 'main.ts'));
const builds = [
  { ...common, entryPoints: [path.join(ROOT, 'src/index.ts')], outfile: path.join(ROOT, 'dist/mo.js') },
  ...examples.map((e) => ({ ...common, entryPoints: [e], outfile: e.replace(/\.ts$/, '.js') })),
];
if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
