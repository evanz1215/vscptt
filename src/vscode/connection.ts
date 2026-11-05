import * as vscode from 'vscode';
import { LoginFailedError, NotLoggedInError } from '../core/errors';
import { PttService } from '../core/service';
import { Session } from '../core/session/session';
import type { Transport } from '../core/transport/transport';
import { connectWs } from '../core/transport/wsTransport';
import type { CredentialStore, SavedLogin } from './credentialStore';
import { describeError } from './errorMessages';
import { type VscpttSettings, toServiceOptions, toSessionOptions } from './settings';

export type ConnectionState = 'disconnected' | 'connecting' | 'ready';

export type RememberChoice = 'password' | 'usernameOnly' | 'no' | 'cancel';

/** Everything the connection needs to ask or tell the user. The real one is in ui.ts. */
export interface LoginUi {
  /** Resolves undefined when the user cancels. `saved.username` pre-fills the box. */
  askCredentials(
    saved: SavedLogin | undefined
  ): Promise<{ username: string; password: string } | undefined>;
  /** Asked after a login with typed credentials succeeded. */
  askRemember(): Promise<RememberChoice>;
  /** The account is already logged in elsewhere. Resolve true only if the user agrees to log that connection out. */
  confirmKickOther(): Promise<boolean>;
  showError(message: string): void;
  showInfo(message: string): void;
  /** The connection ended without the user asking. Resolve 'reconnect' if the user wants to try again. */
  notifyDisconnected(): Promise<'reconnect' | undefined>;
}

export interface ConnectionDeps {
  connect?: () => Promise<Transport>;
  ui: LoginUi;
  store: CredentialStore;
  settings: () => VscpttSettings;
  /** How long shutdown() waits for a polite logout before giving up. */
  shutdownTimeoutMs?: number;
}

/**
 * Owns the one PTT connection of the extension: logging in and out, noticing when it drops, and handing the
 * service to the views. It never types anything itself; that is the Session's job.
 */
export class ConnectionManager implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ConnectionState>();
  readonly onDidChangeState = this.changed.event;

  private session: Session | undefined;
  private current: PttService | undefined;
  private currentState: ConnectionState = 'disconnected';
  private currentUser: string | undefined;
  private loginInFlight: Promise<boolean> | undefined;
  private closingOnPurpose = false;
  private shuttingDown: Promise<void> | undefined;

  constructor(private readonly deps: ConnectionDeps) {}

  get state(): ConnectionState {
    return this.currentState;
  }

  /** The account name while logged in. */
  get username(): string | undefined {
    return this.currentUser;
  }

  /** The service to read PTT with. Throws if there is no usable connection. */
  get service(): PttService {
    if (this.currentState !== 'ready' || !this.current) {
      throw new NotLoggedInError();
    }
    return this.current;
  }

  /**
   * Logs in. A remembered password is used without asking (pass `useSaved: false` to be asked anyway); with none
   * remembered the user is asked. Resolves true when logged in. Failures are shown to the user, never thrown. Concurrent calls share one attempt.
   */
  login(options: { useSaved?: boolean } = {}): Promise<boolean> {
    if (this.currentState === 'ready') {
      return Promise.resolve(true);
    }
    this.loginInFlight ??= this.doLogin(options)
      .catch((error: unknown) => {
        this.setState('disconnected');
        this.deps.ui.showError(describeError(error));
        return false;
      })
      .finally(() => {
        this.loginInFlight = undefined;
      });
    return this.loginInFlight;
  }

  /** Logs in with the remembered password when auto-login is on and there is one. */
  async autoLogin(): Promise<void> {
    if (!this.deps.settings().autoLogin) {
      return;
    }
    const saved = await this.deps.store.load();
    if (saved?.password) {
      await this.login({ useSaved: true });
    }
  }

  async logout(): Promise<void> {
    await this.closeConnection();
  }

  /** Ends the current connection (politely) and logs in again. */
  async reconnect(): Promise<boolean> {
    await this.closeConnection();
    const saved = await this.deps.store.load();
    return this.login({ useSaved: Boolean(saved?.password) });
  }

  /** Politely logs out, but never waits longer than `shutdownTimeoutMs`. Safe to call more than once. */
  shutdown(): Promise<void> {
    this.shuttingDown ??= (async () => {
      const limit = new Promise<void>((resolve) =>
        setTimeout(resolve, this.deps.shutdownTimeoutMs ?? 4000).unref?.()
      );
      await Promise.race([this.closeConnection(), limit]);
      this.session?.dispose();
      this.changed.dispose();
    })();
    return this.shuttingDown;
  }

  dispose(): void {
    void this.shutdown();
  }

  // ---- internals ----

  private setState(state: ConnectionState): void {
    if (state !== this.currentState) {
      this.currentState = state;
      this.changed.fire(state);
    }
  }

  private async doLogin(options: { useSaved?: boolean }): Promise<boolean> {
    const { ui, store, settings } = this.deps;
    const saved = await store.load();

    let credentials: { username: string; password: string } | undefined;
    const typed = !((options.useSaved ?? true) && saved?.password);
    if (!typed) {
      credentials = { username: saved!.username, password: saved!.password! };
    } else {
      credentials = await ui.askCredentials(saved);
      if (!credentials) {
        return false; // cancelled
      }
    }

    this.setState('connecting');
    let transport: Transport;
    try {
      transport = await (this.deps.connect ?? connectWs)();
    } catch (error) {
      this.setState('disconnected');
      ui.showError(describeError(error));
      return false;
    }
    const current = settings();
    const session = new Session(
      transport,
      toSessionOptions(current, () => ui.confirmKickOther())
    );
    const service = new PttService(session, toServiceOptions(current));

    try {
      await service.login(credentials);
    } catch (error) {
      session.dispose();
      this.setState('disconnected');
      ui.showError(describeError(error));
      // A remembered password that no longer works must not be tried again by auto-login.
      if (!typed && error instanceof LoginFailedError && error.reason === 'wrongPassword') {
        await store.forgetPassword();
      }
      return false;
    }

    if (this.shuttingDown) {
      session.dispose(); // VS Code is closing; nobody would log this connection out later
      this.setState('disconnected');
      return false;
    }
    this.session = session;
    this.current = service;
    this.currentUser = credentials.username;
    session.onStateChange((s) => {
      if (s === 'disconnected' && !this.closingOnPurpose && this.session === session) {
        void this.handleLostConnection();
      }
    });
    this.setState('ready');

    if (typed) {
      try {
        await this.offerToRemember(credentials, saved);
      } catch {
        // The login worked; failing to save (for example no keyring) must not undo it.
        ui.showError('登入成功，但無法儲存帳密（VS Code 的安全儲存空間不可用）。');
      }
    }
    return true;
  }

  private async offerToRemember(
    credentials: { username: string; password: string },
    saved: SavedLogin | undefined
  ): Promise<void> {
    const { ui, store } = this.deps;
    const choice = await ui.askRemember();
    if (choice === 'password') {
      await store.remember(credentials.username, credentials.password);
    } else if (choice === 'usernameOnly') {
      await store.rememberUsername(credentials.username);
      await store.forgetPassword(); // never keep a password the user did not agree to keep
    } else if (choice === 'no' && saved?.password) {
      await store.forgetPassword(); // the old password belongs to a login the user is replacing
    }
  }

  private async closeConnection(): Promise<void> {
    // A login that is still being set up would otherwise finish after we claimed to be logged out.
    await this.loginInFlight?.catch(() => undefined);
    const service = this.current;
    if (!service) {
      this.setState('disconnected');
      return;
    }
    this.closingOnPurpose = true;
    try {
      await service.logout();
    } catch {
      // The connection may already be gone; either way we are done.
    } finally {
      this.session?.dispose();
      this.session = undefined;
      this.current = undefined;
      this.currentUser = undefined;
      this.closingOnPurpose = false;
      this.setState('disconnected');
    }
  }

  private async handleLostConnection(): Promise<void> {
    this.session?.dispose();
    this.session = undefined;
    this.current = undefined;
    this.currentUser = undefined;
    this.setState('disconnected');
    if ((await this.deps.ui.notifyDisconnected()) === 'reconnect') {
      const saved = await this.deps.store.load();
      await this.login({ useSaved: Boolean(saved?.password) });
    }
  }
}
