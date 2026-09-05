import type { ModerationProvider, ModerationResult } from '../types';

export interface FakeModerationOptions {
  rejectTextWhen?: (text: string) => string | undefined;
  rejectImageWhen?: (png: Uint8Array) => string | undefined;
}

export class FakeModerationProvider implements ModerationProvider {
  readonly name = 'fake-moderation';
  rejectTextWhen?: (text: string) => string | undefined;
  rejectImageWhen?: (png: Uint8Array) => string | undefined;

  constructor(opts: FakeModerationOptions = {}) {
    this.rejectTextWhen = opts.rejectTextWhen;
    this.rejectImageWhen = opts.rejectImageWhen;
  }

  async checkText(text: string): Promise<ModerationResult> {
    const reason = this.rejectTextWhen?.(text);
    return reason ? { verdict: 'reject', reason } : { verdict: 'pass' };
  }

  async checkImage(png: Uint8Array): Promise<ModerationResult> {
    const reason = this.rejectImageWhen?.(png);
    return reason ? { verdict: 'reject', reason } : { verdict: 'pass' };
  }
}
