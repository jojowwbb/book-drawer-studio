import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SFX_CUE_TYPES } from '@pb/renderer';
import type { SfxCueType } from '@pb/renderer';
import { ensureSfxWav } from './sfx';

describe('ensureSfxWav', () => {
  for (const type of SFX_CUE_TYPES) {
    it(`resolves AI-generated sfx for "${type}"`, () => {
      const asset = ensureSfxWav(type as SfxCueType);
      expect(asset).not.toBeNull();
      // 素材唯一来源：apps/server/assets/sfx-ai（ElevenLabs 预生成）
      expect(asset!.path).toContain('assets/sfx-ai');
      expect(existsSync(asset!.path)).toBe(true);
      expect(asset!.volume).toBeGreaterThan(0);
      expect(asset!.volume).toBeLessThanOrEqual(1);
    });
  }
});
