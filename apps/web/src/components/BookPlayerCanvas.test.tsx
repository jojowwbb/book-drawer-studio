import { act, render, screen, waitFor } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookSpec } from '@pb/renderer';
import { pageStartTimes } from '../lib/spec';

const h = vi.hoisted(() => {
  class FakePlayer {
    static instances: FakePlayer[] = [];
    initCalls = 0;
    destroyed = false;
    played = false;
    seekCalls: number[] = [];
    constructor(
      public canvas: HTMLCanvasElement,
      public book: unknown,
    ) {
      FakePlayer.instances.push(this);
    }
    async init(): Promise<void> {
      this.initCalls++;
    }
    play(): void {
      this.played = true;
    }
    pause(): void {}
    seek(t: number): void {
      this.seekCalls.push(t);
    }
    pageIndexAt(_t: number): number {
      return 0;
    }
    get currentTimeMs(): number {
      return 0;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  return { FakePlayer, instances: FakePlayer.instances };
});

vi.mock('@pb/renderer', () => ({
  BookPlayer: h.FakePlayer,
  BookSpecSchema: { parse: (v: unknown) => v },
}));

import { BookPlayerCanvas, type BookPlayerHandle } from './BookPlayerCanvas';

const spec = {
  id: 'b-zh',
  crossfade_ms: 600,
  pages: [
    { page_id: 'p1', duration_ms: 1000 },
    { page_id: 'p2', duration_ms: 2000 },
  ],
} as unknown as BookSpec;

afterEach(() => {
  cleanup();
  h.instances.length = 0;
});

describe('BookPlayerCanvas', () => {
  it('creates a BookPlayer on the canvas, inits and autoplays', async () => {
    render(<BookPlayerCanvas spec={spec} />);
    expect(screen.getByLabelText('绘本预览画布')).toBeTruthy();
    await waitFor(() => expect(h.instances[0]!.initCalls).toBe(1));
    await waitFor(() => expect(h.instances[0]!.played).toBe(true));
    expect(screen.queryByText('预览加载中…')).toBeNull();
  });

  it('seeks to page start times via the imperative handle', async () => {
    const ref = createRef<BookPlayerHandle>();
    render(<BookPlayerCanvas ref={ref} spec={spec} autoPlay={false} />);
    await waitFor(() => expect(h.instances[0]!.initCalls).toBe(1));
    const starts = pageStartTimes(spec);
    act(() => ref.current?.seekPage(1));
    expect(h.instances[0]!.seekCalls).toEqual([starts[1]]);
  });

  it('destroys the player on unmount', async () => {
    const { unmount } = render(<BookPlayerCanvas spec={spec} />);
    await waitFor(() => expect(h.instances[0]!.initCalls).toBe(1));
    unmount();
    expect(h.instances[0]!.destroyed).toBe(true);
  });
});
