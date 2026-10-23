# mo-scene, version 0

A world hands Mo a directory:

```
<scene>/
  scene.json          the description (below)
  geometry.bin        vertex attributes and indices of every mesh
  instances.bin       one 64-byte record per instance
  terrain-near.f32    heightfield, fine cells over the walkable region
  terrain-far.f32     heightfield, coarse cells over everything in view
```

All binary data is little-endian. Every byte offset is a multiple of 4. World space is the world's own: metres, Y up,
right-handed; the exporter does not recentre anything (the engine renders relative to the eye).

## scene.json

```jsonc
{
  "format": "mo-scene",
  "version": 0,
  "name": "linan-sudi",
  "source": { "repo": "linan", "commit": "abc1234", "exported": "2026-10-23T17:00:00+09:00" },
  "region": { "min": [-900, -400], "max": [100, 700] },       // the walkable area exported (world X, Z)
  "classes": { "SKY": 0, "GROUND": 1, "ROCK": 2, "WATER": 3 }, // name → id: the ids instances and meshes use

  "meshes": [
    {
      "name": "willow-lod0",
      "class": 9,                                               // class of its triangles unless an instance overrides
      "vertexCount": 1234,
      "indexCount": 4567,
      "attributes": {                                           // byte offsets into geometry.bin
        "position": { "offset": 0,     "format": "float32x3" },
        "normal":   { "offset": 14808, "format": "float32x3" },
        "uv":       { "offset": 29616, "format": "float32x2" },  // optional
        "tone":     { "offset": 39488, "format": "float32" }     // optional: albedo luminance per vertex, 0..1
      },
      "index": { "offset": 44424, "format": "uint32" },
      "bounds": { "center": [0, 4.2, 0], "radius": 6.1 },       // in the mesh's own space
      "tone": 0.42                                              // albedo luminance when there is no tone attribute
    }
  ],

  "lodGroups": [
    // a level is used up to "to" metres from the eye; beyond the last level the instance is not drawn
    { "name": "willow", "levels": [ { "mesh": 3, "to": 40 }, { "mesh": 4, "to": 250 }, { "mesh": 5, "to": 1500 } ] }
  ],

  "batches": [
    { "mesh": 0, "first": 0, "count": 1 },                      // instances [first, first + count) of one mesh
    { "lodGroup": 0, "first": 1, "count": 5000 }                // … or of one LOD group
  ],
  "instanceCount": 5001,

  "terrain": {
    "near": { "file": "terrain-near.f32", "origin": [-1200, -700], "cell": 1, "width": 1601, "depth": 1701 },
    "far":  { "file": "terrain-far.f32",  "origin": [-12000, -12000], "cell": 16, "width": 1501, "depth": 1501 },
    "class": 1
  },

  "water": [ { "name": "west-lake", "level": 7.2, "mesh": 12 } ],

  "sun": { "direction": [0.42, 0.31, -0.85] },                  // towards the sun, world space, unit length
  "viewpoints": [ { "id": 2, "name": "苏堤春晓", "position": [-445, 3, 160], "target": [-380, 8, 60], "fovY": 46.6 } ]
}
```

## geometry.bin

Each mesh's attributes and indices are tightly packed arrays at the offsets `scene.json` gives:
`float32x3` positions and normals (normals unit length), `float32x2` uvs, `float32` tone, `uint32` indices,
triangle lists, counter-clockwise front faces.

## instances.bin

`instanceCount` records of 64 bytes:

| bytes | type        | field                                                                             |
|-------|-------------|-----------------------------------------------------------------------------------|
| 0–47  | 12 × f32    | world transform, a 3×4 affine matrix by columns: X axis (3), Y axis (3), Z axis (3), translation (3) |
| 48–51 | u32         | class id; `0xFFFFFFFF` = the mesh's own                                           |
| 52–55 | u32         | seed: stable for the same object across exports (e.g. a hash of its generator id and its origin rounded to 1 cm) |
| 56–59 | f32         | tone multiplier (1 = the mesh's own albedo)                                       |
| 60–63 | u32         | flags: bit 0 casts shadows, bit 1 double-sided, bit 2 water surface               |

Instances of a batch are contiguous; batches do not overlap.

## Heightfields

`float32` heights in metres, row-major: sample (ix, iz) at index `iz * width + ix` lies at world
(`origin[0] + ix · cell`, `origin[1] + iz · cell`). Under water the value is the bed, not the water surface. The near
field covers the region plus a margin; the far field covers everything that can be seen from it.

## Optional fields

A scene may add these; a scene without them is painted from mesh and terrain classes alone.

* **`attributes.class`** (`uint32` per vertex): bits 0–15 the class of the vertex's triangles (the three vertices of a
  triangle agree), `0xFFFF` for the mesh's own; bit 16 set: the triangle is alpha-tested. An instance class other than
  `0xFFFFFFFF` still overrides every triangle. One mesh can then hold bark and leaves, or wood and tiles.
* **`mask`** on a mesh: `{ "texture": 0, "cutoff": 0.5, "all": true }`: its alpha-tested triangles sample
  `textures[texture]` at their uv and are discarded below `cutoff`; with no class attribute, `all` alpha-tests every
  triangle. Mo builds the mask's mip levels so that the covered share stays the same at every level (foliage does not
  thin out with distance).
* **`textures`**: `[{ "name", "file", "width", "height", "format": "r8unorm" }]`, row-major texels, row 0 at v = 0.
* **`terrain.near.classMap`**: `{ "file", "format": "uint8" }`, the class of each near sample (same grid as the
  heights), e.g. GROUND or PAVE.
* **`paths`**: `[{ "name", "points": [[x, z], …], "halfWidth", "slab", "crown" }]`, slab paths along a centre line
  (world X, Z, up to 8 points, up to 4 paths): the ground within `halfWidth` of the line and higher than `crown`
  metres is paving, laid in courses `slab` metres long. Where a scene has paths they decide the paving (an exact edge at
  any distance); otherwise the class map does.
* **`lodGroups[].shadowFrom`**: the finest level that casts the sun's shadow (default 0); an instance drawn at a
  finer level casts through this one (a tree whose finest level is thin alpha-tested strands casts through its crown
  bodies).
* **`attributes.pattern`** (`uint32` per vertex, with `uv`): the surface pattern whose joints the G-buffer draws from
  the metric uv: 1 ashlar (uv = along, up m; blocks 1.45 × 0.62), 2 wall (1.0 × 0.42), 3 curb (long stones 1.9 m),
  4 vault (courses across a barrel: uv = arc, across m), 5 slabs (uv = across, along m; 1.6 × 0.62), 6 steps (1.3 m
  stones), 7 voussoirs (uv.x an index coordinate: a joint at every integer; uv.y radial m), 8 brick (0.36 × 0.09); 0
  none.
* **`viewpoints[].look`**: the id of the look (`looks`) the viewpoint is painted in.
* **`viewpoints[].fitAspect`**: `fovY` holds at this aspect and wider; a narrower screen widens it to keep the same
  horizontal field.

## Large scenes

A scene the size of a city does not fit one file or one upload:

* **`geometry`**: `["geometry.0.bin", "geometry.1.bin", …]` (default `["geometry.bin"]`): the geometry in several
  files, each at most 24 MiB (static hosts cap a file at 25 MiB); every attribute and index reference may carry
  `"file": k`, the index into this list (default 0), its `offset` then counting from the start of that file. No array
  crosses a file boundary; a mesh too large for one file is split into several meshes (a LOD level can hold several,
  below).
* **LOD levels of several meshes**: a level is `{ "meshes": [3, 4, 5], "to": 380 }` (or `{ "mesh": 3, "to": … }` for
  one); every mesh of the level is drawn for the instance (a building's wood, tiles and stone; a mesh split for size).
  `"meshes": []` draws nothing over that range (a far massing that only appears beyond a distance: its group's first
  level is empty). Every mesh of a group is in the instance's space; the level is chosen from the distance between the
  eye and the group's `bounds` (`{ "center", "radius" }` in the instance's space; default the first non-empty level's
  first mesh's bounds), so all the parts of a building change level together. At most 8 meshes per level, 4 levels.
* **Heightfields in bands**: a field's `file` may be a list, `"file": ["terrain-near.0.f32", …]` with
  `"rowsPerFile": n`: each file holds n consecutive rows (the last one the rest), so no file passes 24 MiB; the same for
  a `classMap.file`.
* **`looks`**: `[{ "id", "name", "en", "sun": [x, y, z], "season": "spring" | "summer" | "autumn" | "winter",
  "night": false, "snow": 0, "ink": { … } }]`, the times and seasons a world is painted in: the sun (towards it, unit
  length; at night the moon), and the world's own ink settings for that look (`ink`: names the world chooses; Mo's
  demo reads `ranges` = far ranges painted on the sky, in degrees: base elevation, step, ridge amplitude, count,
  azimuth centre, half width, ink, mist fade). `sun` at the top level is the first look's.

## Walking

* **`walk`**: where a walker may stand, beyond the terrain:
  `{ "waterBelow": 0.3, "decks": [{ "origin": [x, z], "dir": [dx, dz], "halfWidth", "halfLength", "rail": 0.45,
  "profile": { "from", "step", "y": [ … ] } }], "blockers": [{ "circle": [x, z, r] } | { "rect": [cx, cz, halfW,
  halfD, rotY] }] }`. The ground is the higher of the terrain and a deck. A deck is a rectangle in its own frame
  (`origin`, `dir` the world direction of its length, its width across it) whose height along its length is sampled in
  `profile` (`y[i]` at `from + i · step` m, linear between); the outer `rail` metres of its width are not walkable.
  Without a deck, ground lower than `waterBelow` is water and stops the walker at its edge. Blockers (buildings,
  houses, rocks, pagodas: rotation `rotY` about Y, the rectangle's local z = (sin rotY, cos rotY)) cannot be entered.

## What a version-0 exporter leaves out

The sky (the engine paints its own), mist, smoke and spray particles, shadow-only stand-ins, camera-facing impostors,
wind sway and any animation (an animated object is exported at its rest pose). Anything the world's own G-buffer keeps
out is left out.
