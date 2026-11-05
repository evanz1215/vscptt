import { ConnectionManager, type LoginUi, type RememberChoice } from '../../src/vscode/connection';
import { CredentialStore, type SavedLogin } from '../../src/vscode/credentialStore';
import { DEFAULT_SETTINGS, type VscpttSettings } from '../../src/vscode/settings';
import { FakeBbs, type FakeBbsOptions } from '../fakes/fakeBbs';
import type { FakeTransport } from '../fakes/fakeTransport';

/** A LoginUi whose answers are set by the test; it records everything it was asked or told. */
export class FakeUi implements LoginUi {
  /** Answers for askCredentials, in order. `undefined` means the user cancelled. */
  credentials: Array<{ username: string; password: string } | undefined> = [
    { username: 'alice', password: 'secret' },
  ];
  remember: RememberChoice = 'no';
  kickOther = false;
  disconnectedAnswer: 'reconnect' | undefined = undefined;

  askedCredentials: Array<SavedLogin | undefined> = [];
  askedRemember = 0;
  askedKick = 0;
  notifiedDisconnected = 0;
  errors: string[] = [];
  infos: string[] = [];

  async askCredentials(saved: SavedLogin | undefined) {
    this.askedCredentials.push(saved);
    return this.credentials.length > 1 ? this.credentials.shift() : this.credentials[0];
  }
  async askRemember() {
    this.askedRemember++;
    return this.remember;
  }
  async confirmKickOther() {
    this.askedKick++;
    return this.kickOther;
  }
  showError(message: string) {
    this.errors.push(message);
  }
  showInfo(message: string) {
    this.infos.push(message);
  }
  async notifyDisconnected() {
    this.notifiedDisconnected++;
    return this.disconnectedAnswer;
  }
}

export function memoryStore() {
  const secrets = new Map<string, string>();
  const state = new Map<string, unknown>();
  const store = new CredentialStore(
    {
      get: async (k) => secrets.get(k),
      store: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    {
      get: <T>(k: string) => state.get(k) as T | undefined,
      update: async (k, v) => void (v === undefined ? state.delete(k) : state.set(k, v)),
    }
  );
  return { store, secrets, state };
}

export interface Harness {
  manager: ConnectionManager;
  ui: FakeUi;
  store: CredentialStore;
  secrets: Map<string, string>;
  state: Map<string, unknown>;
  /** Every fake server and transport the manager connected to, in order. */
  bbs: FakeBbs[];
  transports: FakeTransport[];
  /** The transport kind of each connection, in order. */
  kinds: string[];
  settings: VscpttSettings;
}

/** A ConnectionManager wired to fake servers, a fake UI and an in-memory credential store. */
export function makeHarness(
  options: {
    bbs?: FakeBbsOptions;
    settings?: Partial<VscpttSettings>;
    ui?: FakeUi;
    shutdownTimeoutMs?: number;
  } = {}
): Harness {
  const ui = options.ui ?? new FakeUi();
  const { store, secrets, state } = memoryStore();
  const bbsList: FakeBbs[] = [];
  const transports: FakeTransport[] = [];
  const kinds: string[] = [];
  const settings: VscpttSettings = {
    ...DEFAULT_SETTINGS,
    keepAliveSeconds: 0,
    ...options.settings,
  };

  const manager = new ConnectionManager({
    connect: async (kind) => {
      kinds.push(kind);
      const bbs = new FakeBbs(options.bbs);
      const transport = bbs.connect();
      bbsList.push(bbs);
      transports.push(transport);
      return transport;
    },
    ui,
    store,
    settings: () => settings,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  });
  return { manager, ui, store, secrets, state, bbs: bbsList, transports, kinds, settings };
}
