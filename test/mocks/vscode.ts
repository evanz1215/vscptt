/**
 * A stand-in for the `vscode` module, aliased in for tests (vitest.config.ts) and for the bundle test.
 * It implements only what src/vscode and src/extension.ts use, and records what the code did so tests can
 * check it: messages shown, commands registered, text copied, documents opened.
 *
 * It is NOT VS Code. It cannot show that a real window behaves; docs/manual-checklist.md covers that.
 */

type Listener<T> = (value: T) => unknown;

export class Disposable {
  constructor(private readonly callOnDispose: () => void = () => {}) {}
  static from(...items: Array<{ dispose(): unknown }>): Disposable {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }
  dispose(): void {
    this.callOnDispose();
  }
}

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value: T): void {
    for (const l of this.listeners) {
      l(value);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string
  ) {}
  static from(parts: { scheme: string; authority?: string; path?: string; query?: string }): Uri {
    return new Uri(parts.scheme, parts.authority ?? '', parts.path ?? '', parts.query ?? '');
  }
  static parse(value: string): Uri {
    const m = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?/i.exec(value);
    if (!m) {
      throw new Error(`cannot parse URI: ${value}`);
    }
    return new Uri(m[1]!, m[2] ?? '', decodeURIComponent(m[3] ?? ''), m[4] ?? '');
  }
  with(change: { path?: string; query?: string }): Uri {
    return new Uri(
      this.scheme,
      this.authority,
      change.path ?? this.path,
      change.query ?? this.query
    );
  }
  toString(): string {
    return `${this.scheme}:${this.authority ? `//${this.authority}` : ''}${encodeURI(this.path)}${this.query ? `?${this.query}` : ''}`;
  }
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  constructor(public value = '') {}
  appendText(text: string): this {
    this.value += text;
    return this;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}
}

export class Range {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number
  ) {}
}

export class Hover {
  constructor(
    readonly contents: MarkdownString,
    readonly range?: Range
  ) {}
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  id?: string;
  description?: string | boolean;
  tooltip?: string | MarkdownString;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  iconPath?: ThemeIcon;
  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
  ) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  Notification = 15,
  Window = 10,
}

export enum ViewColumn {
  Active = -1,
}

// ---- test control surface ----

interface MockState {
  messages: Array<{ level: 'info' | 'warning' | 'error'; message: string; items: string[] }>;
  inputBoxes: Array<{
    prompt?: string;
    password?: boolean;
    value?: string;
    validateInput?: (value: string) => string | undefined;
  }>;
  inputAnswers: Array<string | undefined>;
  quickPickAnswers: Array<string | undefined>;
  quickPickCalls: string[][];
  outputLines: string[];
  messageAnswers: Array<string | undefined>;
  clipboard: string;
  externalLinks: string[];
  commands: Map<string, (...args: unknown[]) => unknown>;
  executed: Array<{ command: string; args: unknown[] }>;
  contexts: Map<string, unknown>;
  config: Map<string, unknown>;
  contentProviders: Map<string, TextDocumentContentProvider>;
  hoverProviders: Array<{ scheme: string; provider: unknown }>;
  shownDocuments: string[];
  shownTexts: string[];
  openedDocuments: string[];
  statusItems: StatusBarItem[];
  treeViews: Array<{ id: string; provider: unknown; disposed: boolean }>;
  configListeners: Set<Listener<{ affectsConfiguration(section: string): boolean }>>;
}

export interface TextDocumentContentProvider {
  onDidChange?: (listener: Listener<Uri>) => Disposable;
  provideTextDocumentContent(uri: Uri): string | Promise<string>;
}

class StatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  name: string | undefined;
  visible = false;
  disposed = false;
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  dispose(): void {
    this.disposed = true;
  }
}

const fresh = (): MockState => ({
  messages: [],
  inputBoxes: [],
  inputAnswers: [],
  quickPickAnswers: [],
  quickPickCalls: [],
  outputLines: [],
  messageAnswers: [],
  clipboard: '',
  externalLinks: [],
  commands: new Map(),
  executed: [],
  contexts: new Map(),
  config: new Map(),
  contentProviders: new Map(),
  hoverProviders: [],
  shownDocuments: [],
  shownTexts: [],
  openedDocuments: [],
  statusItems: [],
  treeViews: [],
  configListeners: new Set(),
});

export const mock: MockState & { reset(): void } = Object.assign(fresh(), {
  reset(): void {
    Object.assign(mock, fresh());
  },
});

const record =
  (level: 'info' | 'warning' | 'error') =>
  async (message: string, ...rest: unknown[]): Promise<string | undefined> => {
    const items = rest.filter((r): r is string => typeof r === 'string');
    mock.messages.push({ level, message, items });
    return mock.messageAnswers.length > 0 ? mock.messageAnswers.shift() : undefined;
  };

export const window = {
  showInformationMessage: record('info'),
  showWarningMessage: record('warning'),
  showErrorMessage: record('error'),
  async showInputBox(
    options: {
      prompt?: string;
      password?: boolean;
      value?: string;
      validateInput?: (value: string) => string | undefined;
    } = {}
  ) {
    mock.inputBoxes.push(options);
    return mock.inputAnswers.shift();
  },
  async showQuickPick(items: string[] | Array<{ label: string }>, _options?: unknown) {
    const labels = items.map((i) => (typeof i === 'string' ? i : i.label));
    mock.quickPickCalls.push(labels);
    return mock.quickPickAnswers.shift();
  },
  createOutputChannel(_name: string) {
    return { appendLine: (line: string) => void mock.outputLines.push(line), dispose() {} };
  },
  createStatusBarItem(_alignment?: StatusBarAlignment, _priority?: number): StatusBarItem {
    const item = new StatusBarItem();
    mock.statusItems.push(item);
    return item;
  },
  createTreeView(id: string, options: { treeDataProvider: unknown }) {
    const view = { id, provider: options.treeDataProvider, disposed: false };
    mock.treeViews.push(view);
    return {
      dispose: () => {
        view.disposed = true;
      },
      reveal: async () => {},
    };
  },
  async showTextDocument(doc: { uri: Uri; getText?: () => string }, _options?: unknown) {
    mock.shownDocuments.push(doc.uri.toString());
    mock.shownTexts.push(doc.getText?.() ?? '');
    return { document: doc };
  },
  async withProgress<T>(_options: unknown, task: () => Promise<T>): Promise<T> {
    return task();
  },
};

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable {
    if (mock.commands.has(id)) {
      throw new Error(`command '${id}' already exists`);
    }
    mock.commands.set(id, handler);
    return new Disposable(() => mock.commands.delete(id));
  },
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    mock.executed.push({ command: id, args });
    if (id === 'setContext') {
      mock.contexts.set(args[0] as string, args[1]);
      return undefined;
    }
    const handler = mock.commands.get(id);
    return handler ? handler(...args) : undefined;
  },
  async getCommands(): Promise<string[]> {
    return [...mock.commands.keys()];
  },
};

export const workspace = {
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const full = section ? `${section}.${key}` : key;
        return (mock.config.has(full) ? mock.config.get(full) : defaultValue) as T | undefined;
      },
    };
  },
  registerTextDocumentContentProvider(
    scheme: string,
    provider: TextDocumentContentProvider
  ): Disposable {
    mock.contentProviders.set(scheme, provider);
    return new Disposable(() => mock.contentProviders.delete(scheme));
  },
  async openTextDocument(uri: Uri) {
    const provider = mock.contentProviders.get(uri.scheme);
    if (!provider) {
      throw new Error(`no content provider for ${uri.scheme}`);
    }
    mock.openedDocuments.push(uri.toString());
    const text = await provider.provideTextDocumentContent(uri);
    return { uri, getText: () => text };
  },
  onDidChangeConfiguration(
    listener: Listener<{ affectsConfiguration(section: string): boolean }>
  ): Disposable {
    mock.configListeners.add(listener);
    return new Disposable(() => mock.configListeners.delete(listener));
  },
};

export const languages = {
  registerHoverProvider(selector: { scheme: string }, provider: unknown): Disposable {
    mock.hoverProviders.push({ scheme: selector.scheme, provider });
    return new Disposable(() => undefined);
  },
};

export const env = {
  async openExternal(uri: Uri): Promise<boolean> {
    mock.externalLinks.push(uri.toString());
    return true;
  },
  clipboard: {
    async writeText(value: string): Promise<void> {
      mock.clipboard = value;
    },
    async readText(): Promise<string> {
      return mock.clipboard;
    },
  },
};

/** Test helper: change a setting and tell listeners. */
export function setConfig(key: string, value: unknown): void {
  mock.config.set(key, value);
  for (const l of mock.configListeners) {
    l({ affectsConfiguration: (section: string) => key.startsWith(section) });
  }
}
