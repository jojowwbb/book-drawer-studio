import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../api/project-client';

vi.mock('../api/project-client', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public payload: unknown,
    ) {
      super(`API error ${status}`);
    }
  },
  createProject: vi.fn(),
}));

import { ProjectCreatePage } from './ProjectCreatePage';

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/project/create']}>
      <Routes>
        <Route path="/project/create" element={<ProjectCreatePage />} />
        <Route path="/project/:id" element={<div>PROJECT_PAGE_PROBE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(createProject).mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectCreatePage', () => {
  it('submits the form and navigates to the new project', async () => {
    vi.mocked(createProject).mockResolvedValue({ project_id: 'p42' });
    renderPage();
    fireEvent.change(screen.getByLabelText('故事主题或整篇文章'), {
      target: { value: '灯塔守夜人' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
    await waitFor(() => expect(screen.getByText('PROJECT_PAGE_PROBE')).toBeTruthy());
    expect(vi.mocked(createProject)).toHaveBeenCalledWith(
      expect.objectContaining({ source: '灯塔守夜人', style: 'anime', format: 'landscape' }),
    );
    const recent = JSON.parse(localStorage.getItem('pb_recent_projects') ?? '[]') as {
      id: string;
    }[];
    expect(recent[0]!.id).toBe('p42');
  });

  it('shows a validation error for an empty source', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(vi.mocked(createProject)).not.toHaveBeenCalled();
  });

  it('offers the four video style presets and submits the selected one', async () => {
    vi.mocked(createProject).mockResolvedValue({ project_id: 'p43' });
    renderPage();
    fireEvent.change(screen.getByLabelText('故事主题或整篇文章'), {
      target: { value: '灯塔守夜人' },
    });
    for (const label of ['真人3D', '卡通二次元', '奇幻绘本', '水墨国风']) {
      expect(screen.getByRole('radio', { name: new RegExp(label) })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('radio', { name: /水墨国风/ }));
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
    await waitFor(() => expect(screen.getByText('PROJECT_PAGE_PROBE')).toBeTruthy());
    expect(vi.mocked(createProject)).toHaveBeenCalledWith(
      expect.objectContaining({ style: 'inkwash' }),
    );
  });
});
