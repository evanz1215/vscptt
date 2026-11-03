import { WaitTimeoutError } from '../queue/waitFor';
import type { Terminal } from './terminal';

export interface SettleOptions {
  /** No screen update for this long counts as "the server has finished". */
  quietMs?: number;
  /** Give up if the screen keeps changing for this long. */
  timeoutMs?: number;
}

/** Resolves once the screen has stopped changing. Use waitFor when you know what to expect; this is the fallback. */
export function waitForQuiet(terminal: Terminal, options: SettleOptions = {}): Promise<void> {
  const { quietMs = 80, timeoutMs = 5000 } = options;

  return new Promise((resolve, reject) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = terminal.onUpdate(() => arm());
    const overall = setTimeout(() => {
      clear();
      reject(new WaitTimeoutError('screen to stop changing', timeoutMs, terminal.lines()));
    }, timeoutMs);

    function clear() {
      unsubscribe();
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
