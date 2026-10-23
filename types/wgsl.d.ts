// WGSL sources are bundled as text (esbuild loader '.wgsl': 'text')
declare module '*.wgsl' {
  const source: string;
  export default source;
}
