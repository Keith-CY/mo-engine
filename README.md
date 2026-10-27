# Mo (墨)

![临安 in Mo: 西湖全景, West Lake from Baoshi Hill, painted live in the browser](docs/img/hero.jpg)

A WebGPU engine, in TypeScript, for walkable worlds painted as Chinese ink. Its first world is 临安, exported from
[Keith-CY/linan](https://github.com/Keith-CY/linan): walk it at https://linan.lapla.si (`examples/linan`, linan's
interface over Mo; the city is 191 MiB packed, 114 MiB of it at the start, each building's finer levels fetched as you
come near). Design: `docs/ARCHITECTURE.md`; the scene files it reads: `docs/SCENE_FORMAT.md`; what comes next:
`docs/PLAN.md`.

Two painters turn the G-buffer into ink. Painter 2 (the default, `src/render/painter2.ts`) is linan's own painter, the
one that made its approved stills, ported pass for pass: a tone from albedo × light with each look's levels baked at
its viewpoint, its ½ and ⅛ blurs, the light on the form, brush outlines through a jump flood, where each pixel sits in
its mass, and the washes, marks and lines of 纯水墨. Painter 1 (`?p2=0`) is Mo's first, one pass.

![Walking 苏堤 through a bridge's arch, captured with tools/capture.mjs](docs/img/walk.webp)

The ten viewpoints of 临安 (keys 1 … 9 and 0 in the demo), as Painter 2 renders them. Top row: 西湖全景, 苏堤春晓,
曲院风荷, 雷峰夕照, 三潭印月; bottom row: 南宋皇城, 临安御街, 飞来峰, 六和塔, 断桥残雪.

![临安's ten viewpoints](docs/img/views.jpg)

```
npm run build      # dist/ (ES modules)
npm run check      # type check
npm run demo       # serve examples/ at http://127.0.0.1:8090 (?scene=<dir>/ &vp=n &look=n &at=x,y,z&to=x,y,z)
npm run comfort    # the comfort checks in headless Chrome (GPU, throwaway profile)
```

Tools (headless Chrome with the GPU and a throwaway profile, unless noted):

```
node tools/shot.mjs --q "scene=…&vp=2" --vps 1,2,3     # screenshots of viewpoints
node tools/capture.mjs --q "scene=…" --path p.json      # a video along a camera path, on the stepped clock
node tools/drawstats.mjs --q "scene=…&vp=2"             # what each pass draws: instances, triangles, heaviest slots
node tools/pack-scene.mjs <scene> <out> [--compact --gzip --lazy]   # (no browser) repack: files of at most 24 MiB;
                                                        # for the web small formats, gzip, buildings' finer levels later
node tools/compare/linan-site.mjs --site <linan> --path p.json   # the same path through linan's own renderer
node tools/compare/stack.mjs left.mp4 right.mp4 out.mp4          # two captures side by side, labelled
node tools/site.mjs --scene <scene> [--page linan]     # (no browser) a page (demo, linan) and its scenes as a static site
node tools/gputime.mjs --q "scene=…" --vps 2,7         # GPU time per pass (stage), averaged over a few seconds
node tools/compare/tone-levels.mjs --scene <s> --ref <dir>       # bake each look's tone levels against linan's tone
```

In the demo: W A S D walk, Shift run, F walk / fly, mouse (double-click to lock) look, 1 … 9 and 0 the viewpoints,
L the next look, H the overlay.
