import { describe, expect, it } from 'vitest';
import { VERSION } from './index';

describe('package', () => {
  it('exports version', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
