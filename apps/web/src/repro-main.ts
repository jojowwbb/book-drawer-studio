import { BookPlayer } from '@pb/renderer';
import { BookSpecSchema, type BookSpec } from '@pb/renderer';

const log = (msg: string): void => {
  const line = `${performance.now().toFixed(0)}ms ${msg}`;
  console.log(line);
  document.getElementById('log')!.textContent += `${line}\n`;
};

window.addEventListener('error', (e) => log(`windowerror: ${String(e.error).slice(0, 200)}`));

async function loadSpec(url: string): Promise<BookSpec> {
  const res = await fetch(url, { cache: 'no-store' });
  return BookSpecSchema.parse(await res.json());
}

async function main(): Promise<void> {
  const created = await fetch('/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme: '探针', page_count: 12 }),
  }).then((r) => r.json() as Promise<{ book_id: string }>);
  const { book_id } = created;
  log(`book ${book_id} created`);

  for (;;) {
    const s = await fetch(`/api/books/${book_id}`).then((r) => r.json() as Promise<{ state: string; preview?: { book_specs: Record<string, string> } }>);
    if (s.state === 'ready' && s.preview) {
      (window as unknown as { __specs: Record<string, string> }).__specs = s.preview.book_specs;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const specs = (window as unknown as { __specs: Record<string, string> }).__specs;
  log('ready');

  const zh = await loadSpec(specs.zh!);
  log('zh spec loaded');
  const en = await loadSpec(specs.en!);
  log('en spec loaded');

  const canvas = document.getElementById('a') as HTMLCanvasElement;

  // #1：完整 init + 播放（React 实例 1）
  const p1 = new BookPlayer(canvas, zh);
  await p1.init();
  p1.play();
  log('p1 playing');
  await new Promise((r) => setTimeout(r, 1500));

  // key 变更 → 实例 1 卸载：完整 destroy（clean）
  p1.destroy();
  log('p1 destroyed (clean)');

  // 实例 2 用旧 spec（zh）挂载 → init#2 立即开始
  const p2 = new BookPlayer(canvas, zh);
  const initP2 = p2.init();
  log('p2 init started (zh, same canvas)');

  // ~50ms 后新 spec 到达：p2 中途 destroy，同 canvas 再 init#3（en）
  await new Promise((r) => setTimeout(r, 50));
  p2.destroy();
  log('p2 destroyed MID-INIT');
  void initP2.catch(() => undefined);

  const p3 = new BookPlayer(canvas, en);
  await p3.init();
  p3.play();
  log('p3 playing (en, same canvas)');

  await new Promise((r) => setTimeout(r, 3000));
  log('ALL_DONE');
}

void main();
