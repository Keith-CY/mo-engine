# Mo (墨)

A WebGPU engine, in TypeScript, for walkable worlds painted as Chinese ink. Its first world is 临安
(https://linan.lapla.si). Design: `docs/ARCHITECTURE.md`; the scene files it reads: `docs/SCENE_FORMAT.md`;
what comes next: `docs/PLAN.md`.

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
node tools/pack-scene.mjs <scene> <out>                 # (no browser) repack a scene into files of at most 24 MiB
node tools/compare/linan-site.mjs --site <linan> --path p.json   # the same path through linan's own renderer
node tools/compare/stack.mjs left.mp4 right.mp4 out.mp4          # two captures side by side, labelled
node tools/site.mjs --scene <scene> [--vp 2]           # (no browser) the demo and its scenes as a static site
```

In the demo: W A S D walk, Shift run, F walk / fly, mouse (double-click to lock) look, 1 … 9 and 0 the viewpoints,
L the next look, H the overlay.
