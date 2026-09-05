import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { BookPage } from './pages/BookPage';
import { CreatePage } from './pages/CreatePage';

describe('app shell', () => {
  it('renders the create page at /', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<CreatePage />} />
          <Route path="/book/:id" element={<BookPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: '绘本工坊' })).toBeTruthy();
  });
});
