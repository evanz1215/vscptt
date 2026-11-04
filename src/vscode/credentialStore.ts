/** The slice of `ExtensionContext.secrets` that is used. */
export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/** The slice of `ExtensionContext.globalState` that is used. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface SavedLogin {
  username: string;
  /** Present only if the user chose to remember it. */
  password?: string;
}

const USERNAME_KEY = 'vscptt.username';
const PASSWORD_KEY = 'vscptt.password';

/**
 * The password lives only in VS Code's SecretStorage and only when the user asked to remember it. The account
 * name is not a secret and is kept in globalState so the login box can be pre-filled.
 */
export class CredentialStore {
  constructor(
    private readonly secrets: SecretStorageLike,
    private readonly state: MementoLike
  ) {}

  async load(): Promise<SavedLogin | undefined> {
    const username = this.state.get<string>(USERNAME_KEY);
    if (!username) {
      return undefined;
    }
    const password = await this.secrets.get(PASSWORD_KEY);
    return password ? { username, password } : { username };
  }

  /** Remember the account name only. */
  async rememberUsername(username: string): Promise<void> {
    await this.state.update(USERNAME_KEY, username);
  }

  /** Remember the account name and the password. */
  async remember(username: string, password: string): Promise<void> {
    await this.secrets.store(PASSWORD_KEY, password); // first, so a failure never pairs a new name with an old password
    await this.state.update(USERNAME_KEY, username);
  }

  /** Forget the password but keep the account name for pre-filling. */
  async forgetPassword(): Promise<void> {
    await this.secrets.delete(PASSWORD_KEY);
  }

  /** Forget everything. */
  async clear(): Promise<void> {
    await this.secrets.delete(PASSWORD_KEY);
    await this.state.update(USERNAME_KEY, undefined);
  }
}
