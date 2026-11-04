export type PttErrorCode =
  | 'loginFailed'
  | 'tooFrequent'
  | 'duplicateLogin'
  | 'connectionClosed'
  | 'unexpectedScreen'
  | 'articleMismatch'
  | 'articleDeleted'
  | 'boardNotFound'
  | 'notLoggedIn'
  | 'invalidArgument';

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

/**
 * Makes a screen line safe to keep in an error or a log: IP addresses (the welcome screen shows the one you
 * last logged in from) and any `secrets` such as the account name are masked.
 */
export function redactLine(line: string, secrets: readonly string[] = []): string {
  let out = line.replace(IPV4, '0.0.0.0');
  for (const secret of secrets) {
    if (secret) {
      out = out.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>');
    }
  }
  return out;
}

export class PttError extends Error {
  constructor(
    message: string,
    readonly code: PttErrorCode,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Never carries the password. The reason is all a caller needs. */
export class LoginFailedError extends PttError {
  constructor(readonly reason: 'wrongPassword' | 'noAccount') {
    super(
      reason === 'noAccount' ? 'Login failed: no such account' : 'Login failed: wrong password',
      'loginFailed'
    );
  }
}

export class TooFrequentError extends PttError {
  constructor() {
    super('PTT refused the login for now ("請稍後再試"); wait before trying again', 'tooFrequent');
  }
}

/**
 * The account is already logged in elsewhere and we chose to keep that connection. Verified on the live server
 * (2026-11-03): PTT then closes the new connection, so this login cannot proceed.
 */
export class DuplicateLoginDeclinedError extends PttError {
  constructor() {
    super(
      'PTT closed this connection: the account is already logged in elsewhere and the other connection was kept',
      'duplicateLogin'
    );
  }
}

export class ConnectionClosedError extends PttError {
  constructor(message = 'The connection to PTT was closed') {
    super(message, 'connectionClosed');
  }
}

/**
 * The screen was not what the current step expects. `snapshot` is the screen lines with IP addresses masked
 * (pass `session.snapshot()` to mask the account name too).
 */
export class UnexpectedScreenError extends PttError {
  readonly snapshot: string[];

  constructor(message: string, snapshot: readonly string[]) {
    super(message, 'unexpectedScreen');
    this.snapshot = snapshot.map((line) => redactLine(line));
  }
}

export class ArticleMismatchError extends PttError {
  constructor(message: string) {
    super(message, 'articleMismatch');
  }
}

/** The list row is PTT's placeholder for a deleted article: there is nothing to open. */
export class ArticleDeletedError extends PttError {
  constructor() {
    super('The article was deleted', 'articleDeleted');
  }
}

export class BoardNotFoundError extends PttError {
  constructor(readonly board: string) {
    super(`Board not found or not accessible: ${board}`, 'boardNotFound');
  }
}

export class NotLoggedInError extends PttError {
  constructor() {
    super('Not logged in', 'notLoggedIn');
  }
}

export class InvalidArgumentError extends PttError {
  constructor(message: string) {
    super(message, 'invalidArgument');
  }
}
