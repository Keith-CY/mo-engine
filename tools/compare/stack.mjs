// Two captures of the same camera path side by side (left the reference, right Mo), each labelled, one video. The
// labels are drawn by headless Chrome (an ffmpeg without drawtext will do).
//
//   node tools/compare/stack.mjs <left.mp4> <right.mp4> <out.mp4> [--left "linan (WebGL2)"] [--right "Mo (WebGPU)"]
//                                [--width 1920] [--crf 20]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome } from '../chrome.mjs';

const pos = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));
const opt = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const [L, R, OUT] = pos;
if (!L || !R || !OUT) { console.error('node tools/compare/stack.mjs <left.mp4> <right.mp4> <out.mp4>'); process.exit(2); }
const W = Number(opt('width', 1920)), half = Math.floor(W / 4) * 2;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-stack-'));
const browser = await launchChrome({ width: 800, height: 200 });
try {
  const page = await browser.newPage();
  for (const [k, text] of [['l', opt('left', 'linan (WebGL2)')], ['r', opt('right', 'Mo (WebGPU)')]]) {
    await page.setContent(`<body style="margin:0;background:transparent"><span id="t" style="display:inline-block;padding:8px 14px;
      font:500 26px/1.2 'PingFang SC','Hiragino Sans GB',system-ui,sans-serif;color:#222;background:rgba(244,239,228,.85);
      border-radius:4px"></span></body>`);
    await page.$eval('#t', (e, s) => { e.textContent = s; }, text);
    await (await page.$('#t')).screenshot({ path: path.join(tmp, `${k}.png`), omitBackground: true });
  }
} finally {
  await browser.cleanup();
}
try {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', L, '-i', R, '-i', path.join(tmp, 'l.png'), '-i', path.join(tmp, 'r.png'), '-filter_complex',
    `[0:v]scale=${half}:-2[a0];[a0][2:v]overlay=24:H-h-24[a];[1:v]scale=${half}:-2[b0];[b0][3:v]overlay=24:H-h-24[b];[a][b]hstack=inputs=2:shortest=1[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-crf', String(opt('crf', 20)), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`[stack] ${OUT}`);
