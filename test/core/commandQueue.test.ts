import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../../src/core/queue/commandQueue';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('CommandQueue', () => {
  it('runs tasks one at a time, in call order, even when called concurrently', async () => {
    const q = new CommandQueue();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await delay(ms);
      log.push(`end ${name}`);
      return name;
    };

    const results = await Promise.all([
      q.run(task('a', 30)),
      q.run(task('b', 5)),
      q.run(task('c', 1)),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('does not let a failing task block the queue, and still reports its error', async () => {
    const q = new CommandQueue();
    const failing = q.run(async () => {
      throw new Error('boom');
    });
    const after = q.run(async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
  });

  it('handles synchronous throws inside a task', async () => {
    const q = new CommandQueue();
    const bad = q.run(() => {
      throw new Error('sync');
    });
    const next = q.run(async () => 1);
    await expect(bad).rejects.toThrow('sync');
    await expect(next).resolves.toBe(1);
  });
});
