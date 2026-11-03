import { WaitTimeoutError } from '../queue/waitFor';
import type { Terminal } from './terminal';

export interface SettleOptions {
  /** No screen update for this long counts as "the server has finished". */
  quietMs?: number;
  /** Give up if the screen keeps changing for this long. */
  timeoutMs?: number;
  /** Abort to stop waiting at once; the promise rejects with `signal.reason`. */
  signal?: AbortSignal;
  /** Applied to each screen line kept in the timeout snapshot. */
  redact?: (line: string) => string;
}

/** Resolves once the screen has stopped changing. Use waitFor when you know what to expect; this is the fallback. */
export function waitForQuiet(terminal: Terminal, options: SettleOptions = {}): Promise<void> {
  const { quietMs = 80, timeoutMs = 5000, signal, redact = (line) => line } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    let quietTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      clear();
      reject(signal!.reason);
    };
    const unsubscribe = terminal.onUpdate(() => arm());
    const overall = setTimeout(() => {
      clear();
      reject(
        new WaitTimeoutError('screen to stop changing', timeoutMs, terminal.lines().map(redact))
      );
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    function clear() {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(overall);
      if (quietTimer !== undefined) {
        clearTimeout(quietTimer);
      }
    }

    function arm() {
      if (quietTimer !== undefined) {
        clearTimeout(quietTimer);
      }
      quietTimer = setTimeout(() => {
        clear();
        resolve();
      }, quietMs);
    }

    arm();
  });
}
