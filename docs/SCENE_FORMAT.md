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
* **`viewpoints[].fitAspect`**: `fovY` holds at this aspect and wider; a narrower screen widens it to keep the same
  horizontal field.

## What a version-0 exporter leaves out

The sky (the engine paints its own), mist, smoke and spray particles, shadow-only stand-ins, camera-facing impostors,
wind sway and any animation (an animated object is exported at its rest pose). Anything the world's own G-buffer keeps
out is left out.
