/**
 * How a world is painted: per class (ground, water, willow, roof, …) its wash, its lines, its marks, how far it carries
 * into the haze and a colour tint; per look the paper, the ink, the light and the haze. A world passes its own table;
 * DEFAULT_STYLE is 纯水墨 (ink only, a warm paper), after the linan painter: contours belong to architecture (界画) and a
 * few key forms; trees, hills, grass and water are described by washes, and their outlines are faint.
 */
import { CLS } from '../scene/types';

/** what a class's marks are (src/shaders/ink.wgsl) */
export const MARK = { NONE: 0, GRAIN: 1, LEAF: 2, VEIL: 3, GRASS: 4, PAVE: 5, ROCK: 6, BLOSSOM: 8 } as const;

export interface ClassStyle {
  /** ink = base + gain · (1 − value)^gamma + shadow · (in the sun's shadow), value = light × albedo */
  wash: [number, number, number, number];
  /** lines: silhouette weight, crease weight, crease threshold (1 − cos of the fold), width (px) */
  line: [number, number, number, number];
  /** marks: amount 0 … 1, feature size on the screen (px), kind (MARK) */
  marks: [number, number, number];
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
  /** far ranges painted on the sky (degrees): base elevation, step, ridge amplitude, count, azimuth centre, half width
   *  (0: all round), ink, mist fade */
  ranges?: [number, number, number, number, number, number, number, number];
  /** fallen petals on the ground: amount, colour (rgb) */
  petals?: [number, number, number, number];
  /** the wash laid in this many layers (墨分五色; 0: smooth), and the dark rim where a layer ends (水渍) */
  layers?: number;
  pool?: number;
  /** 留白, measured from the look's own viewpoint `shotPos` (ground height `groundY` there): up to three bands of mist
   *  lying low at a distance from it ([distance, half width, amount, ceiling m]), and mist below a height ([y0, y1,
   *  beyond this distance, amount]) */
  shotPos?: [number, number, number];
  groundY?: number;
  bands?: [number, number, number, number][];
  mist?: [number, number, number, number];
  /** colour accents (maple, ginkgo, lotus, a warm sky) 0 … 1; the warm sky toward the sun; the sun's glow (its disc,
   *  a pale gold halo, its path on the water); clouds and cloud bands */
  accent?: number;
  warm?: number;
  glow?: number;
  clouds?: number;
  cloudBands?: number;
  /** a sky tint: absorbance (rgb) and amount */
  skyTint?: [number, number, number, number];
  /** the sun's or moon's path on the water: amount, half width (rad), widening per rad below the horizon, dashes */
  moonCol?: [number, number, number, number];
  /** the water's own wash, and the shore's reflection on it: gain (0 none), fade (screen px at 1664 wide; 0 default) */
  waterBase?: number;
  waterRefl?: [number, number];
  /** the look's viewpoint looks along (x, z): ripple lines and wave rows on the water follow it (fixed per look) */
  shotDir?: [number, number];
  waves?: number;
  waveMode?: number;
  /** crown ink, roof ink, leaf marks, joints, relative to the 苏堤 look */
  gains?: [number, number, number, number];
  /** lines full at lineNear m, gone at lineFar m (log scale) */
  lineNear?: number;
  lineFar?: number;
  /** snow on what faces up (0 … 1) */
  snow?: number;
  /** the woods paling upward into haze: from y0 to y1 (m), amount */
  veil?: [number, number, number];
  /** rock painted as planes, fissures and streaks (gain; 0: as the land), near within ridgeFrom m */
  rock?: number;
  ridgeFrom?: number;
  /** a night painting: the sky's ink */
  night?: boolean;
  skyInk?: number;
}

export interface InkStyle {
  look: Look;
  base: ClassStyle;
  classes: Partial<Record<number, Partial<ClassStyle>>>;
}

export const MAX_CLASSES = 32;

const ARCH: Partial<ClassStyle> = { line: [0.8, 0.6, 0.22, 1.0] };

export const DEFAULT_STYLE: InkStyle = {
  look: {
    hazeDistance: 1400, skyLight: 0.5, sunLight: 0.65, paperDrift: 50,
    paperColor: [0.955, 0.93, 0.875], paperTexture: 0.05, inkColor: [0.08, 0.075, 0.07], lineStrength: 1,
    // (linan look 2, 苏堤: three low ranges all round, pale, a short mist fade; spring petals)
    ranges: [2.5, 1.2, 2.5, 3, 0, 0, 0.32, 0.7],
    petals: [1.6, 0.95, 0.84, 0.84],
    layers: 3.5, pool: 0.45,
  },
  base: { wash: [0.06, 0.4, 1.4, 0.3], line: [1.0, 0.0, 0.3, 1.4], marks: [0.4, 8, MARK.GRAIN], haze: 1, tint: [0, 0, 0, 0] },
  classes: {
    // the ground a mid grey with the trees' shadows laid on it dark, in tussocks and sweeps (ink02); the grass pale,
    // drawn by its blades; the slab path paler still, its joints drawn
    [CLS.GROUND]: { wash: [0.17, 0.14, 1.5, 0.38], line: [0.12, 0, 0.3, 1.2], marks: [0.55, 6, MARK.GRAIN] },
    [CLS.SMALL]: { wash: [0.1, 0.12, 1.4, 0.25], line: [0.35, 0, 0.3, 0.8], marks: [0.5, 5, MARK.GRASS] },
    [CLS.PAVE]: { wash: [0.05, 0.05, 1.5, 0.08], line: [0.25, 0, 0.3, 1.0], marks: [0, 8, MARK.NONE] },
    [CLS.ROCK]: { wash: [0.1, 0.55, 1.2, 0.3], line: [0.55, 0.15, 0.75, 1.6], marks: [0.8, 6, MARK.ROCK], haze: 2.2 },
    // the carving in the cliff: a clean, fine drawn line (白描) on its silhouette and every fold; the niche's rim like rock
    [CLS.FIGURE]: { wash: [0.02, 0.1, 1.5, 0.1], line: [0.9, 0.6, 0.12, 0.6], marks: [0, 6, MARK.NONE] },
    [CLS.NICHE]: { wash: [0.25, 0.3, 1.2, 0.2], line: [0.8, 0.3, 0.5, 1.1], marks: [0, 6, MARK.NONE], haze: 2.2 },
    [CLS.WATER]: { wash: [0.0, 0.05, 2.0, 0.1], line: [0, 0, 0.3, 1.0], marks: [0.0, 14, MARK.NONE] },
    // architecture: pale washes, the contours and joints drawn (界画)
    [CLS.ROOF]: { ...ARCH, wash: [0.45, 0.35, 1.2, 0.2], line: [0.8, 0.35, 0.6, 1.0], marks: [0.25, 4, MARK.GRAIN] },
    [CLS.WOOD]: { ...ARCH, wash: [0.35, 0.4, 1.2, 0.2] },
    [CLS.WALL]: { ...ARCH, wash: [0.02, 0.18, 1.8, 0.4], marks: [0.15, 8, MARK.GRAIN] },
    [CLS.STONE]: { ...ARCH, wash: [0.02, 0.1, 1.6, 0.08], line: [0.95, 0.7, 0.22, 1.6], marks: [0, 6, MARK.NONE] },
    [CLS.METAL]: { ...ARCH, wash: [0.4, 0.4, 1.0, 0.2] },
    [CLS.DARK]: { ...ARCH, wash: [0.6, 0.3, 1.0, 0.1] },
    [CLS.GLOW]: { ...ARCH, wash: [0.0, 0.1, 2.0, 0.1] },
    [CLS.BARK]: { wash: [0.55, 0.3, 1.0, 0.15], line: [0.8, 0.1, 0.6, 1.4], marks: [0.3, 5, MARK.GRAIN] },
    // trees: a crown is clumps of wash (wash.x base, wash.y the crown's gain) and leaf marks (marks.x their gain);
    // outlines faint. Willows airy, a veil of strands; pines the darkest (墨松)
    [CLS.WILLOW]: { wash: [0.0, 0.24, 1, 0], line: [0.2, 0, 0.3, 0.8], marks: [1.2, 16, MARK.VEIL] },
    [CLS.BROAD]: { wash: [0.0, 0.75, 1, 0], line: [0.06, 0, 0.3, 0.8], marks: [1.0, 5.5, MARK.LEAF] },
    [CLS.PINE]: { wash: [0.08, 1.2, 1, 0], line: [0.06, 0, 0.3, 0.8], marks: [1.0, 5.5, MARK.LEAF] },
    [CLS.MAPLE]: { wash: [0.0, 0.56, 1, 0], line: [0.06, 0, 0.3, 0.8], marks: [1.0, 5.5, MARK.LEAF] },
    [CLS.GINKGO]: { wash: [0.0, 0.56, 1, 0], line: [0.06, 0, 0.3, 0.8], marks: [1.0, 5.5, MARK.LEAF] },
    // peach blossom: a breath of wash (wash.x + wash.y × shade) under pale pink dots
    [CLS.BLOSSOM]: { wash: [0.09, 0.1, 1, 0], line: [0.05, 0, 0.3, 0.8], marks: [1.0, 5, MARK.BLOSSOM], tint: [0.84, 0.46, 0.5, 0.62] },
    [CLS.BLOOM]: { wash: [0.02, 0.06, 1.5, 0.1], line: [0.75, 0.5, 0.2, 0.8], tint: [0.9, 0.55, 0.6, 0.4] },
    // 墨荷: each lotus leaf one flat wet wash of its own depth (src/shaders/ink.wgsl), veins drawn near
    [CLS.LOTUS]: { wash: [0.5, 0.3, 1, 0.15], line: [0.16, 0, 0.3, 1.0], marks: [0.55, 6, MARK.NONE] },
    [CLS.IVY]: { wash: [0.1, 0.3, 1.2, 0.3], line: [0.3, 0, 0.3, 0.8], marks: [0.6, 4, MARK.LEAF] },
  },
};

/** the table as the painter reads it: 4 × vec4 per class (src/shaders/ink.wgsl) */
export function packStyle(s: InkStyle): Float32Array<ArrayBuffer> {
  const out = new Float32Array(MAX_CLASSES * 16);
  for (let c = 0; c < MAX_CLASSES; c++) {
    const k = { ...s.base, ...(s.classes[c] ?? {}) };
    out.set([...k.wash, ...k.line, ...k.marks, k.haze, ...k.tint], c * 16);
  }
  return out;
}
