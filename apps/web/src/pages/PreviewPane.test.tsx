import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editPageText, regeneratePage } from '../api/client';
import type { BookStatus } from '../api/types';

vi.mock('../api/client', () => ({
  regeneratePage: vi.fn(),
  pollUntilState: vi.fn().mockResolvedValue({}),
  exportBook: vi.fn(),
  editPageText: vi.fn(),
}));

vi.mock('../lib/spec', () => ({
  loadBookSpec: vi.fn(),
  pageStartTimes: (spec: { pages: { duration_ms: number }[] }): number[] => {
    const starts: number[] = [];
    let t = 0;
    for (const p of spec.pages) {
      starts.push(t);
      t += p.duration_ms;
    }
    return starts;
  },
}));

vi.mock('../components/BookPlayerCanvas', () => ({
  BookPlayerCanvas: (): JSX.Element => <div>PLAYER_STUB</div>,
}));

import { loadBookSpec } from '../lib/spec';
import { PreviewPane } from './PreviewPane';

const spec = {
  id: 'b-zh',
  pages: [
    { page_id: 'p1', duration_ms: 1000, background: { src: '/bg1.png' } },
    { page_id: 'p2', duration_ms: 2000, background: { src: '/bg2.png' } },
  ],
};

const status: BookStatus = {
  book_id: 'b1',
  state: 'ready',
  progress: { pages_done: 2, pages_total: 2 },
  preview: { book_specs: { zh: '/assets/b1/zh.json' } },
};

describe('PreviewPane', () => {
  beforeEach(() => {
    vi.mocked(loadBookSpec).mockReset();
    vi.mocked(loadBookSpec).mockResolvedValue(spec as never);
    vi.mocked(regeneratePage).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads the zh spec and shows page indicator and thumbnails', async () => {
    render(<PreviewPane status={status} />);
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy());
    expect(vi.mocked(loadBookSpec)).toHaveBeenCalledWith('/assets/b1/zh.json');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('PLAYER_STUB')).toBeTruthy();
  });

  it('hides the language toggle for single-language books', async () => {
    render(<PreviewPane status={status} />);
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'English' })).toBeNull();
    expect(screen.queryByRole('button', { name: '中文' })).toBeNull();
  });

  it('switches language and reloads the spec when multiple langs exist', async () => {
    const bilingual: BookStatus = {
      ...status,
      preview: { book_specs: { zh: '/assets/b1/zh.json', en: '/assets/b1/en.json' } },
    };
    render(<PreviewPane status={bilingual} />);
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    await waitFor(() =>
      expect(vi.mocked(loadBookSpec)).toHaveBeenCalledWith('/assets/b1/en.json'),
    );
  });

  it('regenerates the active page then reloads the spec', async () => {
    vi.mocked(regeneratePage).mockResolvedValue({ remaining: 2 });
    render(<PreviewPane status={status} />);
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '重画这一页' }));
    await waitFor(() =>
      expect(vi.mocked(regeneratePage)).toHaveBeenCalledWith('b1', 'p1'),
    );
    await waitFor(() =>
      expect(vi.mocked(loadBookSpec).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(screen.getByText('本页还可重画 2 次')).toBeTruthy();
  });

  it('enables the export button when ready without artifacts', async () => {
    render(<PreviewPane status={status} />);
    const btn = await screen.findByRole('button', { name: '导出视频' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the final video and a single download link after completion', async () => {
    vi.mocked(regeneratePage).mockResolvedValue({ remaining: 3 });
    render(<PreviewPane status={{ ...status, exports: {
      zh: { url: '/assets/books/b1/exports/zh.mp4', duration_ms: 5000, size_bytes: 1 },
    } }} />);
    const link = await screen.findByRole('link', { name: '下载视频' });
    expect((link as HTMLAnchorElement).getAttribute('href')).toBe('/assets/books/b1/exports/zh.mp4');
    const video = document.querySelector('video.preview-video');
    expect(video?.getAttribute('src')).toBe('/assets/books/b1/exports/zh.mp4');
  });

  it('disables the export button and shows 导出中 while exporting', async () => {
    render(<PreviewPane status={{ ...status, state: 'exporting' }} />);
    const btn = await screen.findByRole('button', { name: '导出中…' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('edits page narration via the text form', async () => {
    vi.mocked(editPageText).mockResolvedValue({ state: 'editing' });
    vi.mocked(loadBookSpec).mockResolvedValue({
      ...spec,
      pages: [{ ...spec.pages[0], subtitle: { text: '旧的旁白。' } }, spec.pages[1]],
    } as never);
    render(<PreviewPane status={status} />);
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '编辑旁白' }));
    const box = await screen.findByRole('textbox');
    expect((box as HTMLTextAreaElement).value).toBe('旧的旁白。');
    fireEvent.change(box, { target: { value: '新的旁白句子。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并重新配音' }));
    await waitFor(() =>
      expect(vi.mocked(editPageText)).toHaveBeenCalledWith('b1', 'p1', { narration: '新的旁白句子。' }),
    );
  });

  it('reloads the spec when the edited page clip finishes re-rendering', async () => {
    vi.mocked(editPageText).mockResolvedValue({ state: 'editing' });
    const { rerender } = render(<PreviewPane status={status} clipVersions={{}} />);
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '编辑旁白' }));
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: '新的旁白句子。' } });
    const callsBefore = vi.mocked(loadBookSpec).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '保存并重新配音' }));
    await waitFor(() => expect(vi.mocked(editPageText)).toHaveBeenCalled());
    // SSE page_clip ready → clipVersions 递增 → 重载 spec
    rerender(<PreviewPane status={status} clipVersions={{ p1: 1 }} />);
    await waitFor(() =>
      expect(vi.mocked(loadBookSpec).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });
});
