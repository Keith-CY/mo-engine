// The sun's shadow map: casters chosen by the culling pass for each cascade, depth only. (The frame's light
// matrices; this pass's cascade comes as a uniform.)
struct Pass { cascade: u32, visOffset: u32, pad0: u32, pad1: u32 };
struct Draw { visibleBase: u32, cls: u32, tone: f32, hasTone: u32 };

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> S: Pass;
@group(1) @binding(0) var<storage, read> inst: array<u32>;
@group(1) @binding(1) var<storage, read> visible: array<u32>;
@group(2) @binding(0) var<uniform> D: Draw;

fn col(i: u32, c: u32) -> vec3f {
  let b = i * 16u + c * 3u;
  return vec3f(bitcast<f32>(inst[b]), bitcast<f32>(inst[b + 1u]), bitcast<f32>(inst[b + 2u]));
}

@vertex
fn vs(@location(0) p: vec3f, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let i = visible[S.visOffset + D.visibleBase + ii];
  let rel = col(i, 0u) * p.x + col(i, 1u) * p.y + col(i, 2u) * p.z + (col(i, 3u) - F.eye.xyz);
  return F.shadowVP[S.cascade] * vec4f(rel, 1.0);
}
