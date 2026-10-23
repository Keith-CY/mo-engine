# Plan

## Phase 1 — 苏堤, walkable, on Mo

1. **Skeleton** (engine repo): device and pipeline cache, frame loop on the engine clock, camera and first-person
   controller, mesh/instance pools, compute culling + LOD + indirect draws, G-buffer, a first painter (paper on the
   camera sphere, washes with a fixed curve, contour lines), temporal resolve, capture, the comfort checks. Proven on a
   synthetic town.
2. **Exporter** (linan repo, branch): the 苏堤 region as a mo-scene — terrain heightfields, water, the causeway and its
   bridges, buildings, rocks, willows and peaches with their LOD meshes, viewpoints and the sun of look 2.
3. **Real scene**: terrain clipmap, water, shadows, vegetation through the LOD groups.
4. **The painting**: the style table for the classes on 苏堤, tuned side by side with the approved still (ref02 /
   ink02) and the live site.

Done when: the comfort checks pass (turn residual at the resampling floor, flick starts within 2 × the frame target,
no LOD or quality steps while turning), 60 fps while walking and turning at 1440 × 900 on this Mac's GPU when it is not
loaded, and a side-by-side video and link (old site / Mo) go to the owner.

## Later

The whole city, the ten viewpoints, the times of day; lines from geometry where G-buffer contours are not enough;
comfort settings (field of view, mouse speed); offline video from the same engine; a fallback for browsers without
WebGPU (decided at the end of phase 1).
