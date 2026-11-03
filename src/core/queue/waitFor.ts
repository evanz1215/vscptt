import type { Terminal } from '../terminal/terminal';

export class WaitTimeoutError extends Error {
  constructor(
    readonly description: string,
    readonly timeoutMs: number,
    /** The 24 screen lines at the moment of the timeout. Never contains the password (the BBS does not echo it). */
    readonly snapshot: string[]
  ) {
    super(`Timed out after ${timeoutMs} ms waiting for: ${description}`);
    this.name = 'WaitTimeoutError';
  }
}

export interface WaitOptions {
  timeoutMs: number;
  description?: string;
}

/**
 * Resolves with the first truthy value the predicate returns, checked now and after every screen update.
 * Rejects with WaitTimeoutError (including a screen snapshot) if it never matches.
 */
export function waitFor<T>(
  terminal: Terminal,
  predicate: (terminal: Terminal) => T | false | null | undefined,
  options: WaitOptions
): Promise<NonNullable<T>> {
  const { timeoutMs, description = 'screen condition' } = options;

  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      unsubscribe();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };

    const check = (): boolean => {
      try {
        const value = predicate(terminal);
        if (value) {
          finish();
          resolve(value as NonNullable<T>);
          return true;
        }
      } catch (error) {
        finish();
        reject(error);
        return true;
      }
      return false;
    };

    if (check()) {
      return;
    }
    unsubscribe = terminal.onUpdate(check);
    timer = setTimeout(() => {
      unsubscribe();
      reject(new WaitTimeoutError(description, timeoutMs, terminal.lines()));
    }, timeoutMs);
  });
}
