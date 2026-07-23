
declare module 'd3-force-3d' {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export function forceSimulation(nodes?: any[], numDimensions?: number): any
  export function forceManyBody(): any
  export function forceLink(links?: any[]): any
  export function forceCenter(x?: number, y?: number, z?: number): any
  export function forceX(x?: number | ((d: any) => number)): any
  export function forceY(y?: number | ((d: any) => number)): any
  export function forceZ(z?: number | ((d: any) => number)): any
}

declare module '*?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}
