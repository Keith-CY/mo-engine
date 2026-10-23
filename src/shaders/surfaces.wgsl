// The default surface functions: a world may ship its own (scene.json "surfaces", docs/SCENE_FORMAT.md) — WGSL defining
// surfaceTone(s: Surface) -> f32, the albedo luminance of a surface point, which Mo compiles into its G-buffer pass.
// Its inputs are fixed to the surface (the kind, the metric uv, the world's per-vertex paint values, the world point
// and normal, the object's origin and seed), so a turn of the view moves the result rigidly. Derivatives (fwidth) may be
// used for anti-aliasing anywhere in it. Without a world's own, the measured tone is kept.
fn surfaceTone(s: Surface) -> f32 { return s.tone; }
