// Two captures of the same camera path side by side (left the reference, right Mo), each labelled, one video.
//
//   node tools/compare/stack.mjs <left.mp4> <right.mp4> <out.mp4> [--left "linan (WebGL2)"] [--right "Mo (WebGPU)"]
//                                [--width 1920] [--crf 20]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const pos = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));
const opt = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const [L, R, OUT] = pos;
if (!L || !R || !OUT) { console.error('node tools/compare/stack.mjs <left.mp4> <right.mp4> <out.mp4>'); process.exit(2); }
const W = Number(opt('width', 1920)), half = Math.floor(W / 4) * 2;
const FONT = ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/Helvetica.ttc'].find((f) => fs.existsSync(f));
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
const label = (s) => `drawtext=fontfile='${FONT}':text='${esc(s)}':x=24:y=h-th-24:fontsize=26:fontcolor=0x222222:box=1:boxcolor=0xf4efe4@0.8:boxborderw=10`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', L, '-i', R, '-filter_complex',
  `[0:v]scale=${half}:-2,${label(opt('left', 'linan (WebGL2)'))}[a];[1:v]scale=${half}:-2,${label(opt('right', 'Mo (WebGPU)'))}[b];[a][b]hstack=inputs=2:shortest=1[v]`,
  '-map', '[v]', '-c:v', 'libx264', '-crf', String(opt('crf', 20)), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
console.log(`[stack] ${OUT}`);
