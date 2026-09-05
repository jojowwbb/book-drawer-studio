import { beforeEach, describe, expect, it } from 'vitest';
import { listRecentBooks, rememberBook, type RecentBook } from './storage';

beforeEach(() => localStorage.clear());

describe('recent books storage', () => {
  it('returns empty list initially and on corrupted data', () => {
    expect(listRecentBooks()).toEqual([]);
    localStorage.setItem('pb_recent_books', '{oops');
    expect(listRecentBooks()).toEqual([]);
  });

  it('dedupes by id, moves to front and caps at 5', () => {
    for (let i = 1; i <= 6; i++) {
      rememberBook({ id: `b${i}`, theme: `主题${i}`, created_at: i });
    }
    let list = listRecentBooks();
    expect(list.map((b) => b.id)).toEqual(['b6', 'b5', 'b4', 'b3', 'b2']);
    rememberBook({ id: 'b3', theme: '主题3-新', created_at: 99 });
    list = listRecentBooks();
    expect(list[0]!.id).toBe('b3');
    expect(list[0]!.theme).toBe('主题3-新');
    expect(list).toHaveLength(5);
  });
});
