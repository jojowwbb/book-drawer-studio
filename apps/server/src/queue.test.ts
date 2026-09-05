import { describe, expect, it } from 'vitest';
import { SerialQueue } from './queue';
import { EventHub } from './events';

describe('SerialQueue', () => {
  it('runs jobs strictly in order even when earlier jobs fail', async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    const j1 = q.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('a');
      throw new Error('boom');
    });
    const j2 = q.enqueue(async () => {
      order.push('b');
      return 'done';
    });
    await expect(j1).rejects.toThrow('boom');
    expect(await j2).toBe('done');
    expect(order).toEqual(['a', 'b']);
  });
});

describe('EventHub', () => {
  it('delivers to subscribers of the matching book only, and unsubscribes', () => {
    const hub = new EventHub();
    const seen: string[] = [];
    const unsub = hub.subscribe('b1', (m) => seen.push(`${m.bookId}:${m.type}`));
    hub.subscribe('b2', () => seen.push('b2 hit'));
    hub.publish('b1', { bookId: 'b1', type: 'state', state: 'ready' });
    hub.publish('b3', { bookId: 'b3', type: 'completed' });
    unsub();
    hub.publish('b1', { bookId: 'b1', type: 'completed' });
    expect(seen).toEqual(['b1:state']);
  });
});
