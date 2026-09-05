import type { MattingProvider, MatteResult } from '../types';

/** 真实模式的零配置抠图替代：整图单层（预览仅镜头推拉，无主体分层动效）。 */
export class IdentityMattingProvider implements MattingProvider {
  readonly name = 'matting:identity';

  async matte(fullImagePng: Uint8Array, _seed: number): Promise<MatteResult> {
    return { background: fullImagePng, subjects: [] };
  }
}
