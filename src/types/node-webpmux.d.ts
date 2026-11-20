declare module 'node-webpmux' {
  interface Frame {
    delay: number
    width: number
    height: number
  }
  class Image {
    exif: Buffer | undefined
    frames: Frame[]
    load(input: Buffer | string): Promise<void>
    save(path: string | null): Promise<Buffer | void>
    demux(opts: { frame?: number; buffers?: boolean; path?: string }): Promise<Buffer[]>
  }
  const webp: { Image: typeof Image }
  export default webp
}
