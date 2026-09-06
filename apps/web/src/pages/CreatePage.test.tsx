import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBook } from '../api/client';

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public payload: unknown,
    ) {
      super(`API error ${status}`);
    }
  },
  createBook: vi.fn(),
}));

import { ApiError } from '../api/client';
import { CreatePage } from './CreatePage';

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<CreatePage />} />
        <Route path="/book/:id" element={<div>BOOK_PAGE_PROBE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(createBook).mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CreatePage', () => {
  it('submits the form and navigates to the new book', async () => {
    vi.mocked(createBook).mockResolvedValue({ book_id: 'b42' });
    renderPage();
    fireEvent.change(screen.getByLabelText('故事主题或整篇文章'), {
      target: { value: '小恐龙学飞' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
    await waitFor(() => expect(screen.getByText('BOOK_PAGE_PROBE')).toBeTruthy());
    expect(vi.mocked(createBook)).toHaveBeenCalledWith({
      theme: '小恐龙学飞',
      style: 'watercolor',
      lang: 'zh',
      format: 'landscape',
      enhance: false,
      bgm: true,
      transition: 'slideleft',
    });
    const recent = JSON.parse(localStorage.getItem('pb_recent_books') ?? '[]') as {
      id: string;
    }[];
    expect(recent[0]!.id).toBe('b42');
  });

  it('passes a user-entered title to the API', async () => {
    vi.mocked(createBook).mockResolvedValue({ book_id: 'b43' });
    renderPage();
    fireEvent.change(screen.getByLabelText('故事主题或整篇文章'), {
      target: { value: '小恐龙学飞' },
    });
    fireEvent.change(screen.getByLabelText('书名（可选）'), {
      target: { value: '勇敢的小恐龙' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
    await waitFor(() => expect(screen.getByText('BOOK_PAGE_PROBE')).toBeTruthy());
    expect(vi.mocked(createBook)).toHaveBeenCalledWith({
      theme: '小恐龙学飞',
      title: '勇敢的小恐龙',
      style: 'watercolor',
      lang: 'zh',
      format: 'landscape',
      enhance: false,
      bgm: true,
      transition: 'slideleft',
    });
  });

  it('submits portrait format when 竖版 is selected', async () => {
    vi.mocked(createBook).mockResolvedValue({ book_id: 'b44' });
    renderPage();
    fireEvent.change(screen.getByLabelText('故事主题或整篇文章'), {
      target: { value: '小恐龙学飞' },
    });
    fireEvent.click(screen.getByRole('button', { name: '竖版 9:16' }));
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
    await waitFor(() => expect(screen.getByText('BOOK_PAGE_PROBE')).toBeTruthy());
    expect(vi.mocked(createBook)).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'portrait' }),
    );
  });

  it('submits bgm=false when the music switch is unchecked', async () => {
    vi.mocked(createBook).mockResolvedValue({ book_id: 'b45' });
    renderPage();
    fireEvent.change(screen.getByLabelText('故事主题或整篇文章'), {
      target: { value: '小恐龙学飞' },
    });
    fireEvent.click(screen.getByLabelText(/背景音乐/));
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
    await waitFor(() => expect(screen.getByText('BOOK_PAGE_PROBE')).toBeTruthy());
    expect(vi.mocked(createBook)).toHaveBeenCalledWith(expect.objectContaining({ bgm: false }));
  });

  it('submits the selected transition type', async () => {
    vi.mocked(createBook).mockResolvedValue({ book_id: 'b46' });
    renderPage();
    fireEvent.change(screen.getByLabelText('故事主题或整篇文章'), {
      target: { value: '小恐龙学飞' },
    });
    fireEvent.click(screen.getByRole('button', { name: '渐隐' }));
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
    await waitFor(() => expect(screen.getByText('BOOK_PAGE_PROBE')).toBeTruthy());
    expect(vi.mocked(createBook)).toHaveBeenCalledWith(expect.objectContaining({ transition: 'fade' }));
  });

  it('shows a validation error for an empty theme', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(vi.mocked(createBook)).not.toHaveBeenCalled();
  });

  it('shows a moderation message when the API rejects input', async () => {
    vi.mocked(createBook).mockRejectedValue(new ApiError(400, { error: 'input_rejected' }));
    renderPage();
    fireEvent.change(screen.getByLabelText('故事主题或整篇文章'), { target: { value: '坏主题' } });
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
    await waitFor(() =>
      expect(screen.getByText('主题未通过安全审核，请换一个更温和的主题')).toBeTruthy(),
    );
  });
});
