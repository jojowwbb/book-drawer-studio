import { BookSpecSchema, type BookSpec } from '@pb/renderer';

export async function loadBookSpec(url: string): Promise<BookSpec> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`failed to load book spec: ${res.status}`);
  const json: unknown = await res.json();
  return BookSpecSchema.parse(json);
}

export function pageStartTimes(spec: BookSpec): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const page of spec.pages) {
    starts.push(t);
    t += page.duration_ms;
  }
  return starts;
}
