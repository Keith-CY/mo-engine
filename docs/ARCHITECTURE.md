# Mo (墨) — architecture

Mo is a WebGPU engine, written in TypeScript, for walkable worlds that are painted rather than lit. It reads a world
from a scene file and paints it as Chinese ink. Its first world is 临安 (Southern Song Hangzhou,
github.com/Keith-CY/linan); later cities reuse it. Mo knows nothing about any one city: a world gives it a scene file,
a style table (how each class of thing is painted, per look), viewpoints and its own interface.

## 1. What the engine must guarantee

The old renderer (three.js WebGL2 + a screen-space painter) made people dizzy when they turned the view. These rules
come from measuring it and from the research on temporal coherence and motion sickness (sources at the end). They
come first in every design choice below.

1. **Only the projection may depend on the view direction.** Every mark, noise, level of detail, line width and tone
   is a function of world position and eye position. A turn on the spot is then one rigid motion of the whole image
   and nothing can swim or boil. Nothing is anchored to the screen, except the interface.
2. **No whole-image swaps tied to moving or stopping.** Refinement converges in place (temporal accumulation in the
   same reprojected history). A different picture never replaces the one on the screen when the camera stops or starts.
3. **The paper lives on a sphere around the eye,** sampled by world view direction: exact under turns. While walking it
   drifts slowly with forward speed (a "dynamic canvas"), never fixed to the screen.
4. **Ink texture lives on surfaces** (world or object space), with octaves chosen by distance so marks keep their size
   on the screen ("infinite zoom" textures), and seeded per object so they never re-hash.
5. **Levels of detail are chosen by straight-line distance** from the eye, with hysteresis, changed by dissolving, with
   budgets per region, never per view.
6. **Fixed exposure.** Paper white and ink black do not follow the frame's histogram; tone comes from the look.
7. **60 fps while turning.** Resolution drops before frame rate does; the quality ladder changes only at a pause.
   Pipelines are compiled before the first frame (no compile hitch mid-walk). No per-frame CPU work proportional to
   the number of objects.
8. **Deterministic time.** Everything that moves reads the engine's clock, so a video capture steps it frame by frame.

Each rule has a measurement in `tools/comfort` (section 9); a change that breaks one fails its check.

## 2. Coordinates and units

World space is the world's own: metres, Y up, right-handed, the camera looking down −Z (the same as the linan world,
so its viewpoints carry over). Depth is reverse-Z (1 at the near plane, 0 at infinity) with a 32-bit float depth
buffer: an 0.2 m near plane and 30 km of view without z-fighting.

Positions far from the origin lose float precision in shaders. GPU positions are relative to a per-frame **anchor**
near the eye (camera-relative rendering): instance transforms are uploaded once in world space as f32, and the vertex
shader subtracts the anchor in two halves (high/low split) before projecting.

## 3. Layers

```
app (a world: linan)      scene files, style table, viewpoints, interface, its own controller tuning
──────────────────────────────────────────────────────────────────────────────────────────────────────
controls/   first-person walker (walk / run / fly), raw mouse look, touch; no camera smoothing, no head-bob
capture/    virtual clock, frame stepping, read-back for video
ink/        the painter: paper, washes, lines, marks, mist — fed by the G-buffer and the style table
render/     frame graph: shadow cascades → G-buffer → light → ink → temporal resolve → present
scene/      the scene file loader, GPU pools (geometry, instances), culling + LOD in compute, indirect draws
terrain/    heightfield terrain (near detail grid + far grid), meshed on the GPU around the eye
gpu/        device, buffers, textures, pipeline cache (async, warmed up), bind groups, timers
core/       Engine (canvas, resize, frame loop), Camera (pose → view, projection), math, events
```

Dependencies only point down. `gpu/` and `core/` know nothing about ink; `ink/` knows nothing about linan.

## 4. Frame

```
input → controller → camera pose (clock dt)
compute: cull + LOD per instance (frustum, distance with hysteresis) → per (mesh, level) visible lists → indirect args
         (the view's lists: only what the last frame's occlusion test saw)
shadow:  2–3 cascades, texel-snapped to the world (no shimmer while turning), refreshed by distance moved, not per frame
gbuffer: one pass, MRT
           A rgba16float  view normal (oct, 2) · view depth (m) · class id
           B rgba16float  sun irradiance (N·L × shadow) · sky irradiance × AO · albedo luminance · emissive
           C rgba32uint   object seed · instance id · surface uv packed (for marks anchored to the surface)
           depth32float   reverse-Z
occlusion: the depth so far reduced to a pyramid of farthest depths; every instance in view tested against it; what
         it sees that the first lists left out drawn into the same G-buffer (nothing appears a frame late), what it
         finds the next frame's first lists
ink:     paper (camera sphere) → washes (tone → ink, fixed curve per look) → surface marks → lines → mist
resolve: reprojection through depth; the history converges to the full-quality painting while the eye rests
present: to the canvas (and to the capture target when capturing)
```

## 5. Scene

A world arrives as a **mo-scene** directory (`docs/SCENE_FORMAT.md`): meshes, instances, LOD groups, terrain
heightfields, water, viewpoints. At load:

* all meshes go into one vertex pool and one index pool (no per-mesh buffers, no per-draw binds);
* all instances go into one storage buffer (world transform, class, seed, tone, flags);
* each batch is one (mesh or LOD group) × a run of instances.

Every frame a compute pass culls each instance against the frustum and the shadow cascades, picks its LOD level by
distance (a per-instance state word keeps the last level for hysteresis and the dissolve phase) and appends it to the
visible list of its (mesh, level); one `drawIndexedIndirect` per (mesh, level) draws them. CPU cost per frame does not
grow with the number of objects. Occlusion is tested in two phases on the GPU (src/shaders/cull.wgsl): the view first
draws what was seen last frame, then every instance in view is tested against a pyramid of the farthest depths drawn so
far (src/shaders/hiz.wgsl: its bounding sphere's exact screen rectangle, read where it spans 2 × 2 texels) and what is
seen but not yet drawn is drawn in a second pass into the same G-buffer. Only what lies wholly behind drawn surfaces is
left out, so the picture is the same as drawing everything; at 飞来峰, at the foot of the cliff, two thirds of the view's
triangles (the woods behind it) go. Vegetation is just instanced meshes with LOD groups (no camera-facing impostors:
they turn with the view).

## 6. Terrain

Two heightfields: near (≈1 m cells over the world's walkable region) and far (≈16 m cells over everything in view).
A fixed grid of tiles around the eye, nested rings of doubling cell size (geometry clipmap), samples them in the vertex
shader; ring transitions morph by distance (no popping). Normals come from the heightfield. A class map (ground,
paving, rock) can ride along.

## 7. Ink

The style table maps each class (ground, water, willow, roof, …) to how it is painted per look: wash curve, mark kind,
line weight, colour accent. The painter's stages:

* **Paper** — a fibre/stain texture from 3D noise on the world view direction (camera sphere), plus a slow drift with
  forward motion. Never screen-anchored.
* **Washes** — light (sun irradiance with shadow, sky irradiance) → ink density through the look's fixed curve, graded
  by distance (atmospheric perspective) and mist bands measured in the world.
* **Surface marks** — dry brush, 皴, leaf dots, tile rhythm: solid/triplanar textures in world or object space, octave
  chosen by world distance and blended across octaves (constant mark size on screen), seeded by object.
* **Lines** — contours from G-buffer discontinuities (depth, normal, object id): they sit on the geometry, so they move
  with it. Width by world distance; thin lines fade by coverage instead of stepping; supersampled through the history.
* **Mist** — by world distance and height.
* **Refinement** — jittered sub-pixel samples accumulate in the reprojected history: a resting view converges to the
  full painting without a swap; moving, the history follows the reprojection and a tight neighbourhood clamp.

## 8. Time and capture

`Engine.clock` is the only source of time (frame loop, animation, fades, CSS sync via an event). Live, it follows
`requestAnimationFrame`; capturing, the capture driver steps it by exactly 1/fps and reads the frame back. Work that
needs real time (loading, pipeline compile) happens before the clock starts or is waited for off the clock.

## 9. Comfort checks (`tools/comfort`)

Headless Chrome with the GPU, throwaway profile:

* **turn residual** — a pure turn captured on the virtual clock; each frame is warped by the camera's exact rotation and
  compared with the next. What remains (outside the interface) is motion the turn does not explain. Target ≤ the
  resampling floor of a static photo-like render.
* **flick test** — turn 0.5 s, rest 0.8 s, repeated: frame times at each flick's start, no frame over 2 × the target.
* **walk/turn frame times** — mean, p95, max while walking and turning.
* **level steps** — no LOD or quality change while turning (logged).

## Sources

Bénard, Bousseau, Thollot 2011, temporal coherence for stylized animations (STAR); Cunzi et al. 2003, Dynamic Canvas;
Lucas Pope, Return of the Obra Dinn devlog (dither on a camera sphere); Johansen, surface-stable fractal dithering;
Bénard 2009 dynamic solid textures; Kalnins 2003 coherent stylized silhouettes; Nooij et al. 2017 and Keshavarz et al.
2015 on vection and motion sickness. Links in `docs/RESEARCH.md`.
