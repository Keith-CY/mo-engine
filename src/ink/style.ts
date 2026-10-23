/**
 * How a world is painted: per class (ground, water, willow, roof, …) a wash curve, a line weight, its surface marks,
 * how far it carries into the haze and a colour tint; per look the paper, the ink, the light and the haze. A world
 * passes its own table; DEFAULT_STYLE is 纯水墨 (ink only, a warm paper).
 */
import { CLS } from '../scene/types';

export interface ClassStyle {
  /** ink = base + gain · (1 − value)^gamma, value = light × albedo */
  wash: [number, number, number];
  /** contour weight, 0 … 1 */
  line: number;
  /** marks: amount 0 … 1, feature size on the screen (px) */
  marks: [number, number];
  /** haze distance multiplier (far hills carry further) */
  haze: number;
  /** tint colour and amount (0 = ink only) */
  tint: [number, number, number, number];
}

export interface Look {
  /** distance (m) over which ink fades into the paper */
  hazeDistance: number;
  skyLight: number;
  sunLight: number;
  /** metres of forward travel per paper turn (the sheet's slow drift along a walk) */
  paperDrift: number;
  paperColor: [number, number, number];
  paperTexture: number;
  inkColor: [number, number, number];
  lineStrength: number;
}

export interface InkStyle {
  look: Look;
  base: ClassStyle;
  classes: Partial<Record<number, Partial<ClassStyle>>>;
}

export const MAX_CLASSES = 32;

export const DEFAULT_STYLE: InkStyle = {
  look: {
    hazeDistance: 1100, skyLight: 0.55, sunLight: 0.6, paperDrift: 50,
    paperColor: [0.94, 0.91, 0.84], paperTexture: 0.05, inkColor: [0.08, 0.075, 0.07], lineStrength: 0.9,
  },
  base: { wash: [0.06, 0.55, 1.6], line: 0.8, marks: [0.5, 8], haze: 1, tint: [0, 0, 0, 0] },
  classes: {
    [CLS.GROUND]: { wash: [0.02, 0.32, 1.8], line: 0.3, marks: [0.7, 10] },
    [CLS.ROCK]: { wash: [0.05, 0.7, 1.3], line: 0.9, marks: [0.8, 6], haze: 2.2 },
    [CLS.WATER]: { wash: [0.0, 0.12, 2.0], line: 0.0, marks: [0.6, 14] },
    [CLS.ROOF]: { wash: [0.25, 0.6, 1.2], line: 1.0, marks: [0.3, 4] },
    [CLS.WALL]: { wash: [0.0, 0.22, 2.0], line: 0.9, marks: [0.2, 8] },
    [CLS.WOOD]: { wash: [0.2, 0.6, 1.3], line: 0.9 },
    [CLS.STONE]: { wash: [0.03, 0.4, 1.5], line: 0.8 },
    [CLS.PAVE]: { wash: [0.0, 0.2, 2.0], line: 0.5, marks: [0.3, 12] },
    [CLS.BARK]: { wash: [0.3, 0.6, 1.0], line: 0.9 },
    [CLS.WILLOW]: { wash: [0.08, 0.5, 1.4], line: 0.6, marks: [0.9, 5] },
    [CLS.BROAD]: { wash: [0.12, 0.65, 1.2], line: 0.7, marks: [0.9, 5] },
    [CLS.PINE]: { wash: [0.15, 0.7, 1.1], line: 0.7, marks: [0.9, 4] },
    [CLS.MAPLE]: { wash: [0.1, 0.6, 1.2], line: 0.7, marks: [0.9, 5] },
    [CLS.GINKGO]: { wash: [0.08, 0.55, 1.3], line: 0.7, marks: [0.9, 5] },
    [CLS.BLOSSOM]: { wash: [0.02, 0.3, 1.5], line: 0.5, marks: [0.9, 4], tint: [0.85, 0.45, 0.5, 0.55] },
  },
};

/** the table as the painter reads it: 3 × vec4 per class (src/shaders/ink.wgsl) */
export function packStyle(s: InkStyle): Float32Array<ArrayBuffer> {
  const out = new Float32Array(MAX_CLASSES * 12);
  for (let c = 0; c < MAX_CLASSES; c++) {
    const k = { ...s.base, ...(s.classes[c] ?? {}) };
    out.set([...k.wash, k.line, ...k.marks, k.haze, 0, ...k.tint], c * 12);
  }
  return out;
}
