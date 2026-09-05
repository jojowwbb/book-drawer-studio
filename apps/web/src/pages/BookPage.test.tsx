import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBook, resumeBook } from '../api/client';
import type { BookStatus } from '../api/types';
import { BookPage } from './BookPage';

vi.mock('../api/client', () => ({
  getBook: vi.fn(),
  regeneratePage: vi.fn(),
  resumeBook: vi.fn(),
  pollUntilState: vi.fn(),
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
}

const generating: BookStatus = {
  book_id: 'b1',
  state: 'pages_generating',
  progress: { pages_done: 0, pages_total: 3 },
};

function renderBookPage(): void {
  render(
    <MemoryRouter initialEntries={['/book/b1']}>
      <Routes>
        <Route path="/" element={<div>HOME_PROBE</div>} />
        <Route path="/book/:id" element={<BookPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BookPage', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(getBook).mockReset();
    vi.mocked(resumeBook).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows progress and live updates from the SSE stream', async () => {
    vi.mocked(getBook).mockResolvedValue(generating);
    renderBookPage();
    await waitFor(() => expect(screen.getByText('插画与配音生成中')).toBeTruthy());
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.emit({
        bookId: 'b1',
        type: 'progress',
        progress: { pages_done: 1, pages_total: 3 },
      });
    });
    expect(screen.getByText('已完成 1 / 3 页')).toBeTruthy();
  });

  it('switches to the preview pane when the book is ready', async () => {
    vi.mocked(getBook).mockResolvedValue({
      ...generating,
      state: 'ready',
      preview: { book_specs: { zh: '/z.json', en: '/e.json' } },
    });
    renderBookPage();
    expect(await screen.findByRole('button', { name: '导出视频' })).toBeTruthy();
  });

  it('refetches full status when the stream reports completion', async () => {
    vi.mocked(getBook)
      .mockResolvedValueOnce(generating)
      .mockResolvedValueOnce({
        ...generating,
        state: 'ready',
        preview: { book_specs: { zh: '/z.json', en: '/e.json' } },
      });
    renderBookPage();
    await waitFor(() => expect(screen.getByText('插画与配音生成中')).toBeTruthy());
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.emit({ bookId: 'b1', type: 'completed' });
    });
    expect(await screen.findByRole('button', { name: '导出视频' })).toBeTruthy();
  });

  it('keeps the preview pane after export completes', async () => {
    vi.mocked(getBook).mockResolvedValue({
      ...generating,
      state: 'completed',
      preview: { book_specs: { zh: '/z.json', en: '/e.json' } },
      exports: {
        zh: { url: '/assets/books/b1/exports/zh.mp4', duration_ms: 5000, size_bytes: 1 },
      },
    });
    renderBookPage();
    expect(await screen.findByRole('link', { name: '下载视频' })).toBeTruthy();
  });

  it('offers resume on failed states', async () => {
    vi.mocked(getBook).mockResolvedValue({
      ...generating,
      state: 'failed_pages_generating',
      error: '图像后端故障',
    });
    vi.mocked(resumeBook).mockResolvedValue({ state: 'pages_generating' });
    renderBookPage();
    expect(await screen.findByText('插画与配音生成失败')).toBeTruthy();
    expect(screen.getByText('图像后端故障')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '从失败阶段继续' }));
    await waitFor(() => expect(vi.mocked(resumeBook)).toHaveBeenCalledWith('b1'));
  });
});
