import type { VideoClipRequest, VideoClipResult, VideoGenProvider } from '../types';

/** 最小 mp4 头（ftyp box）；测试里 probeDurationMs 通常被注入桩替换，不依赖真实解码 */
const MP4_STUB = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x61, 0x76, 0x63, 0x31,
]);

export interface FakeVideoClipOptions {
  /** 注入失败（前 n 次调用抛错），测试重试链路 */
  failTimes?: number;
  delayMs?: number;
}

/** 图生视频桩：返回固定 mp4 字节，可选前 N 次失败 */
export class FakeVideoClipProvider implements VideoGenProvider {
  readonly name = 'fake-video-clip';
  calls = 0;

  constructor(private readonly opts: FakeVideoClipOptions = {}) {}

  async generateClip(_req: VideoClipRequest): Promise<VideoClipResult> {
    this.calls += 1;
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (this.opts.failTimes && this.calls <= this.opts.failTimes) {
      throw new Error(`fake video clip failure (${this.calls})`);
    }
    return { video: MP4_STUB };
  }
}
