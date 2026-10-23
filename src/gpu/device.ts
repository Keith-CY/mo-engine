/** The GPU: adapter, device, the canvas context and the optional features the engine uses when they are there. */
export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  /** the canvas's preferred format */
  format: GPUTextureFormat;
  timestamps: boolean;
}

export class NoWebGPU extends Error {
  constructor(why: string) {
    super(`WebGPU is not available: ${why}`);
  }
}

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!('gpu' in navigator)) throw new NoWebGPU('this browser has no navigator.gpu');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new NoWebGPU('no adapter');
  const want: GPUFeatureName[] = ['timestamp-query', 'float32-filterable'];
  const requiredFeatures = want.filter((f) => adapter.features.has(f));
  const L = adapter.limits;
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxBufferSize: L.maxBufferSize,
      maxColorAttachmentBytesPerSample: L.maxColorAttachmentBytesPerSample,
      maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage,
    },
  });
  device.lost.then((info) => console.error(`[mo] GPU device lost (${info.reason}): ${info.message}`));
  device.addEventListener('uncapturederror', (e) => console.error('[mo] GPU error:', (e as GPUUncapturedErrorEvent).error.message));
  const context = canvas.getContext('webgpu');
  if (!context) throw new NoWebGPU('no webgpu canvas context');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  return { adapter, device, context, format, timestamps: requiredFeatures.includes('timestamp-query') };
}

/** a buffer filled from `data` */
export function bufferFrom(device: GPUDevice, data: ArrayBufferView, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
  const size = Math.max(16, Math.ceil(data.byteLength / 4) * 4);
  const b = device.createBuffer({ label, size, usage: usage | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
  new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  b.unmap();
  return b;
}
