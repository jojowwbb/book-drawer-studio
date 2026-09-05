export interface RecentBook {
  id: string;
  theme: string;
  created_at: number;
}

const KEY = 'pb_recent_books';
const MAX = 5;

export function listRecentBooks(): RecentBook[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentBook[]) : [];
  } catch {
    return [];
  }
}

export function rememberBook(book: RecentBook): void {
  const rest = listRecentBooks().filter((b) => b.id !== book.id);
  const next = [book, ...rest].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
}

export interface RecentProject {
  id: string;
  source: string;
  created_at: number;
}

const PROJECT_KEY = 'pb_recent_projects';

export function listRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentProject[]) : [];
  } catch {
    return [];
  }
}

export function rememberProject(project: RecentProject): void {
  const rest = listRecentProjects().filter((p) => p.id !== project.id);
  const next = [project, ...rest].slice(0, MAX);
  localStorage.setItem(PROJECT_KEY, JSON.stringify(next));
}
