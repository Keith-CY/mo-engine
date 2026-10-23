/**
 * Mip levels of a one-channel alpha mask for alpha-tested cards (leaves, strands). A plain average thins foliage out
 * with distance — fewer texels pass the cutoff at every level — so each level is scaled until the share of its texels
 * at or above the cutoff is that of level 0 (coverage-preserving mipmaps, Castaño 2010).
 */
export interface MipLevel { width: number; height: number; data: Uint8Array<ArrayBuffer> }

function coverage(d: Uint8Array, scale: number, cut: number): number {
  let n = 0;
  for (let i = 0; i < d.length; i++) if (d[i] * scale >= cut) n++;
  return n / d.length;
}

export function alphaMips(data: Uint8Array<ArrayBuffer>, width: number, height: number, cutoff: number): MipLevel[] {
  const cut = cutoff * 255;
  const target = coverage(data, 1, cut);
  const out: MipLevel[] = [{ width, height, data }];
  let src: Uint8Array = data, w = width, h = height;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const avg = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1), y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
      avg[y * nw + x] = (src[y0 * w + x0] + src[y0 * w + x1] + src[y1 * w + x0] + src[y1 * w + x1]) / 4;
    }
    // the scale that keeps level 0's coverage (bisection)
    const tmp = new Uint8Array(avg.length);
    for (let i = 0; i < avg.length; i++) tmp[i] = avg[i];
    let lo = 0.25, hi = 8;
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      if (coverage(tmp, mid, cut) < target) lo = mid; else hi = mid;
    }
    const s = (lo + hi) / 2;
    const next = new Uint8Array(avg.length);
    for (let i = 0; i < avg.length; i++) next[i] = Math.min(255, Math.round(avg[i] * s));
    out.push({ width: nw, height: nh, data: next });
    src = next; w = nw; h = nh;
  }
  return out;
}
