import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForQuiet } from '../../src/core/terminal/settle';
import { Terminal } from '../../src/core/terminal/terminal';
import { WaitTimeoutError, waitFor } from '../../src/core/queue/waitFor';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('waitFor', () => {
  it('resolves immediately when the screen already matches', async () => {
    const t = new Terminal();
    await t.write(utf8('主功能表'));
    await expect(
      waitFor(t, (x) => x.line(0).includes('主功能表'), { timeoutMs: 1000 })
    ).resolves.toBe(true);
  });

  it('resolves with the predicate value once a later update matches', async () => {
    const t = new Terminal();
    const pending = waitFor(t, (x) => x.line(0).match(/(\d+) 頁/)?.[1], { timeoutMs: 1000 });
    await t.write(utf8('loading'));
    await t.write(utf8('\r第 3 頁'));
    await expect(pending).resolves.toBe('3');
  });

  it('rejects with a snapshot when nothing matches in time', async () => {
    const t = new Terminal();
    await t.write(utf8('wrong screen'));

    const error = await waitFor(t, (x) => x.line(0).includes('expected'), {
      timeoutMs: 50,
      description: 'the board list',
    }).catch((e) => e);

    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error.description).toBe('the board list');
    expect(error.snapshot).toHaveLength(24);
    expect(error.snapshot[0]).toBe('wrong screen');
  });

  it('propagates predicate errors instead of hanging', async () => {
    const t = new Terminal();
    await expect(
      waitFor(
        t,
        () => {
          throw new Error('bad predicate');
        },
        { timeoutMs: 1000 }
      )
    ).rejects.toThrow('bad predicate');
  });

  it('stops listening after it resolves', async () => {
    const t = new Terminal();
    let calls = 0;
    const pending = waitFor(
      t,
      (x) => {
        calls++;
        return x.line(0).includes('go');
      },
      { timeoutMs: 1000 }
    );
    await t.write(utf8('go'));
    await pending;
    const before = calls;
    await t.write(utf8('more'));
    expect(calls).toBe(before);
  });
});

// xterm batches writes with setTimeout, so under fake timers a write only completes once the clock moves.
async function feed(t: Terminal, text: string) {
  const done = t.write(utf8(text));
  await vi.advanceTimersByTimeAsync(5);
  await done;
}

describe('waitForQuiet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the quiet period with no updates', async () => {
    const t = new Terminal();
    let done = false;
    void waitForQuiet(t, { quietMs: 80 }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(79);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });

  it('keeps waiting while updates keep arriving', async () => {
    const t = new Terminal();
    let done = false;
    void waitForQuiet(t, { quietMs: 100, timeoutMs: 5000 }).then(() => (done = true));
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(60);
      await feed(t, 'x');
    }
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    expect(done).toBe(true);
  });

  it('rejects if the screen never stops changing', async () => {
    const t = new Terminal();
    const outcome = waitForQuiet(t, { quietMs: 100, timeoutMs: 300 }).catch((e) => e);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(70);
      await feed(t, 'x');
    }
    expect(await outcome).toBeInstanceOf(WaitTimeoutError);
  });
});
