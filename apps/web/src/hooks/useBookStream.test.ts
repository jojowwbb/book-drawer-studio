import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBook } from '../api/client';
import type { BookStatus } from '../api/types';
import { useBookStream } from './useBookStream';

vi.mock('../api/client', () => ({
  getBook: vi.fn(),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  emitRaw(raw: string): void {
    this.onmessage?.({ data: raw });
  }
}

const initial: BookStatus = {
  book_id: 'b1',
  state: 'pages_generating',
  progress: { pages_done: 0, pages_total: 3 },
};

describe('useBookStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(getBook).mockResolvedValue({
      ...initial,
      state: 'ready',
      preview: { book_specs: { zh: '/assets/books/b1/book_specs/zh.json' } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('subscribes to the book event stream and merges state/progress events', () => {
    const { result } = renderHook(() => useBookStream(initial));
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('/api/books/b1/events');

    act(() => es.emit({ bookId: 'b1', type: 'state', state: 'story_generating' }));
    expect(result.current.status.state).toBe('story_generating');

    act(() =>
      es.emit({
        bookId: 'b1',
        type: 'progress',
        progress: { pages_done: 2, pages_total: 3 },
      }),
    );
    expect(result.current.status.progress).toEqual({ pages_done: 2, pages_total: 3 });
    expect(result.current.connected).toBe(true);
  });

  it('ignores messages from other books and malformed JSON', () => {
    const { result } = renderHook(() => useBookStream(initial));
    const es = FakeEventSource.instances[0]!;
    act(() => es.emit({ bookId: 'other', type: 'state', state: 'ready' }));
    expect(result.current.status.state).toBe('pages_generating');
    act(() => es.emitRaw('not-json'));
    expect(result.current.status.state).toBe('pages_generating');
    act(() => es.emit({ bookId: 'b1', type: 'state', state: 'ready' }));
    expect(result.current.status.state).toBe('ready');
  });

  it('records error from failed events', () => {
    const { result } = renderHook(() => useBookStream(initial));
    const es = FakeEventSource.instances[0]!;
    act(() =>
      es.emit({ bookId: 'b1', type: 'state', state: 'failed_pages_generating' }),
    );
    act(() => es.emit({ bookId: 'b1', type: 'failed', error: '图像后端故障' }));
    expect(result.current.status.state).toBe('failed_pages_generating');
    expect(result.current.status.error).toBe('图像后端故障');
  });

  it('on completed refetches full status with preview and keeps the stream open', async () => {
    const { result } = renderHook(() => useBookStream(initial));
    const es = FakeEventSource.instances[0]!;
    act(() => es.emit({ bookId: 'b1', type: 'completed' }));
    await waitFor(() => expect(result.current.status.preview).toBeDefined());
    expect(result.current.status.state).toBe('ready');
    expect(es.closed).toBe(false);
    expect(vi.mocked(getBook)).toHaveBeenCalledWith('b1');
  });

  it('closes the stream on unmount', () => {
    const { unmount } = renderHook(() => useBookStream(initial));
    const es = FakeEventSource.instances[0]!;
    unmount();
    expect(es.closed).toBe(true);
  });
});
