// Headless Chrome for the render tools (macOS, Apple Silicon).
//
// Every launch gets its OWN fresh, empty profile under out/chrome-profiles/<random> that is deleted when
// the browser closes. It never touches your own Chrome profile, never attaches to a running browser
// (no remote-debugging port: puppeteer talks over a pipe) and never clears anything browser-wide.
//
// WebGPU (and WebGL) run on the GPU: WebGPU through Dawn's Metal backend, WebGL through ANGLE's. Override the binary with CHROME=/path/to/chrome
// and the ANGLE backend with ANGLE=metal|gl|swiftshader (swiftshader = CPU fallback, very slow).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES = path.join(ROOT, 'out', 'chrome-profiles');

export const CHROME = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean).find((p) => fs.existsSync(p));

export function gpuArgs() {
  return [
    '--use-angle=' + (process.env.ANGLE || 'metal'),
    '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-webgl', '--enable-gpu-rasterization',
    '--disable-gpu-watchdog',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--js-flags=--max-old-space-size=16384',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
  ];
}

/**
 * Launch headless Chrome with a throwaway profile.
 * @returns {Promise<import('puppeteer-core').Browser & { cleanup(): Promise<void>, profileDir: string }>}
 */
export async function launchChrome({ width = 1280, height = 720, protocolTimeout = 3600 * 1000, extraArgs = [] } = {}) {
  if (!CHROME) throw new Error('Google Chrome not found (set CHROME=/path/to/chrome)');
  fs.mkdirSync(PROFILES, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(PROFILES, 'p-'));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    dumpio: !!process.env.CHROME_DUMPIO,   // CHROME_DUMPIO=1: Chrome's own stderr (GPU / renderer crash reasons)
    userDataDir: profileDir,
    protocolTimeout,
    args: [...gpuArgs(), `--window-size=${Math.min(width, 1920)},${Math.min(height, 1080)}`, ...extraArgs],
    defaultViewport: { width: Math.min(width, 1920), height: Math.min(height, 1080) },
  });
  let closed = false;
  browser.profileDir = profileDir;
  browser.cleanup = async () => {
    if (closed) return;
    closed = true;
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    try { browser.process()?.kill('SIGKILL'); } catch {}
    killProfileProcesses(profileDir);
    removeProfile(profileDir);
  };
  return browser;
}

/** kill helper processes (GPU, renderer) that still carry OUR unique profile path on their command line */
export function killProfileProcesses(profileDir) {
  if (!profileDir || !profileDir.startsWith(PROFILES)) return;
  try { execFileSync('pkill', ['-9', '-f', profileDir], { stdio: 'ignore' }); } catch { /* none left */ }
}

export function removeProfile(profileDir) {
  if (!profileDir || !profileDir.startsWith(PROFILES + path.sep)) return;
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch { /* files still held: retry */ }
  }
}

/** remove profiles left behind by crashed runs whose processes are gone */
export function sweepStaleProfiles(maxAgeMs = 6 * 3600 * 1000) {
  let names = [];
  try { names = fs.readdirSync(PROFILES); } catch { return; }
  for (const n of names) {
    const p = path.join(PROFILES, n);
    try {
      const st = fs.statSync(p);
      if (Date.now() - st.mtimeMs < maxAgeMs) continue;
      let alive = false;
      try { execFileSync('pgrep', ['-f', p], { stdio: 'ignore' }); alive = true; } catch { alive = false; }
      if (!alive) removeProfile(p);
    } catch { /* raced */ }
  }
}
