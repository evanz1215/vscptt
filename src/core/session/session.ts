import {
  ConnectionClosedError,
  InvalidArgumentError,
  NotLoggedInError,
  UnexpectedScreenError,
  redactLine,
} from '../errors';
import { Keys } from '../keys';
import { CommandQueue } from '../queue/commandQueue';
import { WaitTimeoutError, waitFor } from '../queue/waitFor';
import {
  isAnyKeyPrompt,
  isBoardSelectPrompt,
  isSearchPrompt,
  isLogoutConfirm,
  isMainMenu,
} from '../screens/prompts';
import { waitForQuiet } from '../terminal/settle';
import { Terminal } from '../terminal/terminal';
import type { CloseInfo, Transport } from '../transport/transport';
import { runLogin } from './loginFlow';

export type SessionState = 'connecting' | 'loggingIn' | 'ready' | 'disconnected';

export interface Credentials {
  username: string;
  password: string;
}

export type DuplicateSessionPolicy = 'ask' | 'kick' | 'keep';

export interface SessionOptions {
  /**
   * Defaults to a Big5 terminal: the WebSocket gateway starts in Big5 and the login switches it to UTF-8. Pass a
   * UTF-8 terminal for SSH, which is UTF-8 from the start; the login then leaves out the switching comma.
   */
  terminal?: Terminal;
  /** Quiet time that counts as "the server finished drawing". */
  settleMs?: number;
  /** Longest wait for any single expected screen. */
  stepTimeoutMs?: number;
  /** Send a keep-alive key after this much idle time. 0 turns it off. */
  keepAliveMs?: number;
  keepAliveKey?: string;
  /** What to do when PTT asks whether to log out the other connection. `keep` (and `ask` without a callback) answers no, and PTT then closes this connection: the login fails with DuplicateLoginDeclinedError. */
  duplicateSession?: DuplicateSessionPolicy;
  /** Called for `ask`; resolve true to kick the other connection. */
  onDuplicateSession?: () => Promise<boolean>;
}

export interface SessionSettings {
  settleMs: number;
  stepTimeoutMs: number;
  keepAliveMs: number;
  keepAliveKey: string;
  duplicateSession: DuplicateSessionPolicy;
  onDuplicateSession?: () => Promise<boolean>;
}

const USERNAME = /^[A-Za-z][A-Za-z0-9]{1,11}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * One logged-in (or logging-in) connection: a terminal screen fed by a transport, a queue that runs one
 * operation at a time, and helpers that wait for screens. It never types anything the caller did not ask for.
 */
export class Session {
  readonly terminal: Terminal;
  readonly settings: SessionSettings;
  /** Resolves when the connection ends, for any reason. */
  readonly closed: Promise<CloseInfo>;

  private readonly queue = new CommandQueue();
  private readonly abort = new AbortController();
  private readonly stateListeners = new Set<(state: SessionState) => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private currentState: SessionState = 'connecting';
  private keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveClosed!: (info: CloseInfo) => void;
  private disposed = false;
  /** Masked out of every snapshot that leaves this class (the account name shows on the status line). */
  private secrets: string[] = [];
  /** Bytes are parsed into the screen asynchronously; this is the tail of that chain. */
  private pendingWrites: Promise<void> = Promise.resolve();
  /** Counts screen updates, so a caller can tell that something new has been drawn since a moment ago. */
  private updates = 0;

  constructor(
    private readonly transport: Transport,
    options: SessionOptions = {}
  ) {
    this.terminal = options.terminal ?? new Terminal({ encoding: 'big5' });
    this.settings = {
      settleMs: options.settleMs ?? 80,
      stepTimeoutMs: options.stepTimeoutMs ?? 5000,
      keepAliveMs: options.keepAliveMs ?? 30_000,
      keepAliveKey: options.keepAliveKey ?? Keys.REDRAW,
      duplicateSession: options.duplicateSession ?? 'ask',
      onDuplicateSession: options.onDuplicateSession,
    };
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.unsubscribe.push(
      this.terminal.onUpdate(() => {
        this.updates++;
      }),
      transport.onData((data) => {
        this.pendingWrites = this.pendingWrites
          .then(() => (this.disposed ? undefined : this.terminal.write(data)))
          .catch(() => {}); // a failed write must not stop later writes or the close handling
      }),
      transport.onClose((info) => this.handleClose(info))
    );
  }

  get state(): SessionState {
    return this.currentState;
  }

  get lines(): string[] {
    return this.terminal.lines();
  }

  /** The screen lines with IP addresses and the account name masked; safe to put in an error or a log. */
  snapshot(): string[] {
    return this.terminal.lines().map((line) => redactLine(line, this.secrets));
  }

  onStateChange(listener: (state: SessionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Throws unless the session is logged in and connected. */
  assertReady(): void {
    if (this.currentState === 'ready') {
      return;
    }
    throw this.currentState === 'disconnected'
      ? new ConnectionClosedError()
      : new NotLoggedInError();
  }

  /** Types keys. Throws ConnectionClosedError if the connection is gone. */
  send(...keys: string[]): void {
    if (this.abort.signal.aborted || !this.transport.isOpen) {
      throw new ConnectionClosedError();
    }
    this.transport.send(keys.join(''));
    this.armKeepAlive();
  }

  /** Waits for the predicate to return something truthy; fails at once if the connection closes. */
  waitFor<T>(
    predicate: (lines: string[]) => T | false | null | undefined,
    description: string,
    timeoutMs: number = this.settings.stepTimeoutMs
  ): Promise<NonNullable<T>> {
    return waitFor(this.terminal, (t) => predicate(t.lines()), {
      timeoutMs,
      description,
      signal: this.abort.signal,
      redact: (line) => redactLine(line, this.secrets),
    });
  }

  /** Types keys, then waits until the screen differs from before. */
  async sendAndWaitChange(
    keys: string,
    description: string,
    timeoutMs: number = this.settings.stepTimeoutMs
  ): Promise<void> {
    const before = this.terminal.text();
    this.send(keys);
    await this.waitFor(() => this.terminal.text() !== before, description, timeoutMs);
    // The first change can be a partly drawn screen. Never act on it.
    await this.settle();
  }

  /**
   * Types the answer to a prompt and waits until that prompt is gone, then lets the next screen finish drawing.
   * Prompts echo what is typed, so "the screen changed" would be true before the answer was even accepted and
   * the caller could answer a second time, typing into whatever screen comes next.
   */
  async answer(
    keys: string,
    stillShown: (lines: string[]) => boolean,
    description: string,
    timeoutMs: number = this.settings.stepTimeoutMs
  ): Promise<void> {
    this.send(keys);
    await this.waitFor((lines) => !stillShown(lines), description, timeoutMs);
    await this.settle();
  }

  /**
   * Waits until the server has dealt with everything typed so far. The BBS handles keys in order, so a redraw
   * request is answered only after the keys before it; when its answer arrives, their effect is on screen.
   * Resolves false if no answer came in time (the server ignored the redraw), in which case nothing is known.
   */
  async flush(timeoutMs = 2000): Promise<boolean> {
    const seen = this.updates;
    this.send(Keys.REDRAW);
    try {
      await this.waitFor(() => this.updates > seen, 'the redraw answer', timeoutMs);
    } catch (error) {
      if (error instanceof WaitTimeoutError) {
        return false;
      }
      throw error;
    }
    await this.settle();
    return true;
  }

  settle(): Promise<void> {
    return waitForQuiet(this.terminal, {
      quietMs: this.settings.settleMs,
      timeoutMs: this.settings.stepTimeoutMs,
      signal: this.abort.signal,
      redact: (line) => redactLine(line, this.secrets),
    });
  }

  /** Runs `task` after everything queued before it. Operations that touch the screen must go through here. */
  run<T>(task: () => Promise<T>): Promise<T> {
    return this.queue.run(task);
  }

  /**
   * Walks back to the main menu from wherever the screen is. Call it inside `run`. Used to start an operation
   * from a known place and to recover after something unexpected.
   */
  async toMainMenu(): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      await this.settle(); // decide from a finished screen, not one that is still being drawn
      const lines = this.lines;
      const confirmingExit = isLogoutConfirm(lines);
      // The exit prompt is drawn over the main menu (row 0 still says 主功能表), so look for it first.
      if (!confirmingExit && isMainMenu(lines)) {
        return;
      }
      try {
        if (confirmingExit) {
          // never leave by accident
          await this.answer(`N${Keys.ENTER}`, isLogoutConfirm, 'the exit prompt to close', 3000);
        } else if (isBoardSelectPrompt(lines)) {
          await this.answer(Keys.ENTER, isBoardSelectPrompt, 'the board prompt to close', 3000);
        } else if (isSearchPrompt(lines)) {
          // An empty answer cancels the search prompt; Left would only move the text cursor.
          await this.answer(Keys.ENTER, isSearchPrompt, 'the search prompt to close', 3000);
        } else {
          const key = isAnyKeyPrompt(lines) ? Keys.SPACE : Keys.LEFT;
          await this.sendAndWaitChange(key, 'the screen to change', 3000);
        }
      } catch (error) {
        if (!(error instanceof WaitTimeoutError)) {
          throw error;
        }
      }
    }
    if (!isMainMenu(this.lines)) {
      throw new UnexpectedScreenError('Could not get back to the main menu', this.snapshot());
    }
  }

  async login(credentials: Credentials): Promise<void> {
    if (!USERNAME.test(credentials.username)) {
      throw new InvalidArgumentError(
        'Username must be 2-12 letters or digits and start with a letter'
      );
    }
    if (credentials.password === '' || CONTROL.test(credentials.password)) {
      throw new InvalidArgumentError('Password is empty or contains control characters');
    }
    if (this.currentState === 'disconnected') {
      throw new ConnectionClosedError();
    }
    if (this.currentState !== 'connecting') {
      throw new InvalidArgumentError('This session has already been used to log in');
    }

    this.secrets = [credentials.username];
    this.setState('loggingIn');
    try {
      await this.queue.run(() => runLogin(this, credentials));
      this.setState('ready');
      this.armKeepAlive();
    } catch (error) {
      this.transport.close(); // never leave a half-logged-in connection behind
      throw error;
    }
  }

  /** Leaves politely. Always ends with the connection closed. */
  async logout(): Promise<void> {
    if (this.currentState === 'disconnected') {
      return;
    }
    if (this.currentState !== 'ready') {
      // Still connecting or logging in: there is no menu to walk, just hang up.
      this.transport.close();
      await Promise.race([
        this.closed,
        new Promise((resolve) => setTimeout(resolve, 2000).unref?.()),
      ]);
      return;
    }
    try {
      await this.queue.run(async () => {
        await this.toMainMenu();
        this.send('G', Keys.ENTER);
        await this.waitFor(isLogoutConfirm, 'logout confirmation');
        this.send('Y', Keys.ENTER);
        await this.waitFor(isAnyKeyPrompt, 'goodbye screen');
        this.send(Keys.SPACE);
        await Promise.race([
          this.closed,
          new Promise((resolve) => setTimeout(resolve, 5000).unref?.()),
        ]);
      });
    } catch (error) {
      if (!(error instanceof ConnectionClosedError)) {
        throw error;
      }
    } finally {
      this.transport.close();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearKeepAlive();
    for (const off of this.unsubscribe) {
      off();
    }
    this.transport.close();
    this.finishClose({ code: 1000, reason: 'disposed' });
    this.terminal.dispose();
  }

  private handleClose(info: CloseInfo): void {
    this.clearKeepAlive();
    // Let the screen finish parsing what arrived before the close, so a final message such as
    // "請稍後再試" is still seen by whoever is waiting for it.
    void this.pendingWrites.then(() => this.finishClose(info));
  }

  private finishClose(info: CloseInfo): void {
    this.clearKeepAlive();
    if (!this.abort.signal.aborted) {
      this.abort.abort(new ConnectionClosedError());
    }
    this.setState('disconnected');
    this.resolveClosed(info);
  }

  private setState(state: SessionState): void {
    if (state === this.currentState) {
      return;
    }
    this.currentState = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer !== undefined) {
      clearTimeout(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  private armKeepAlive(): void {
    this.clearKeepAlive();
    if (!this.settings.keepAliveMs || this.currentState !== 'ready') {
      return;
    }
    this.keepAliveTimer = setTimeout(() => {
      // Goes through the queue so it never lands in the middle of an operation.
      void this.queue
        .run(async () => {
          if (this.currentState === 'ready' && this.transport.isOpen) {
            this.transport.send(this.settings.keepAliveKey);
          }
        })
        .then(
          () => this.armKeepAlive(),
          () => {}
        );
    }, this.settings.keepAliveMs);
    this.keepAliveTimer.unref?.();
  }
}
