/**
 * The eye: a position (64-bit, in the world's metres), a heading (yaw, turning right is positive; 0 looks down −Z), a
 * pitch, and a fixed vertical field of view. The GPU sees the world relative to the eye (camera-relative rendering),
 * so the matrices below carry the rotation and the projection only; positions are moved to the eye on the GPU.
 *
 * Projection: reverse-Z with the far plane at infinity (depth 1 at the near plane, 0 at the horizon), for a 32-bit
 * float depth buffer that keeps 0.2 m and 30 km apart.
 */
export interface Pose {
  position: [number, number, number];
  yaw: number;
  pitch: number;
  fovY: number;
}

export class Camera {
  position: [number, number, number] = [0, 1.6, 0];
  yaw = 0;
  pitch = 0;
  /** vertical field of view, degrees */
  fovY = 55;
  near = 0.2;
  aspect = 16 / 10;
  width = 1;
  height = 1;
  /** sub-pixel offset of this frame's samples (px), for the temporal resolve */
  jitter: [number, number] = [0, 0];

  /** unit vector the eye looks along */
  forward(): [number, number, number] {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
  }

  right(): [number, number, number] {
    return [Math.cos(this.yaw), 0, Math.sin(this.yaw)];
  }

  /** look from `position` at `target` */
  lookAt(position: [number, number, number], target: [number, number, number]): void {
    this.position = [...position];
    const dx = target[0] - position[0], dy = target[1] - position[1], dz = target[2] - position[2];
    this.yaw = Math.atan2(dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  pose(): Pose {
    return { position: [...this.position], yaw: this.yaw, pitch: this.pitch, fovY: this.fovY };
  }

  setPose(p: Pose): void {
    this.position = [...p.position];
    this.yaw = p.yaw;
    this.pitch = p.pitch;
    this.fovY = p.fovY;
  }

  /** world → view rotation, column-major 4 × 4 (rows: right, up, back) */
  viewRotation(out = new Float32Array(16)): Float32Array {
    const f = this.forward(), r = this.right();
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const b = [-f[0], -f[1], -f[2]];
    out.set([r[0], u[0], b[0], 0, r[1], u[1], b[1], 0, r[2], u[2], b[2], 0, 0, 0, 0, 1]);
    return out;
  }

  /** reverse-Z, infinite far plane, with this frame's jitter; column-major 4 × 4 */
  projection(out = new Float32Array(16), jitter = true): Float32Array {
    const f = 1 / Math.tan((this.fovY * Math.PI) / 360);
    out.fill(0);
    out[0] = f / this.aspect;
    out[5] = f;
    out[11] = -1;
    out[14] = this.near;
    if (jitter) {
      // x_ndc = (… + m8 · z) / −z: an offset of +j px is m8 = −2j / width
      out[8] = (-2 * this.jitter[0]) / this.width;
      out[9] = (-2 * this.jitter[1]) / this.height;
    }
    return out;
  }
}
