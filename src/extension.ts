import * as vscode from 'vscode';
import type { Transport } from './core/transport/transport';
import { ARTICLE_SCHEME, ArticleContentProvider } from './vscode/articleProvider';
import { BoardsTreeProvider } from './vscode/boardsTree';
import { registerCommands } from './vscode/commands';
import { ConnectionManager } from './vscode/connection';
import { setErrorLogger } from './vscode/errorMessages';
import { CredentialStore } from './vscode/credentialStore';
import { OpenedBoards } from './vscode/openedBoards';
import { type VscpttSettings, readSettings } from './vscode/settings';
import { StatusBarController } from './vscode/statusBar';
import { VscodeLoginUi } from './vscode/ui';

/** Only tests change these. */
export interface ExtensionOverrides {
  connect?: () => Promise<Transport>;
}

/** Read fresh on every login, so a changed setting applies the next time you log in. */
function currentSettings(): VscpttSettings {
  const config = vscode.workspace.getConfiguration('vscptt');
  return readSettings((key) => config.get(key));
}

/** Wires everything together. Split from `activate` so tests can plug in a fake server. */
export function createExtension(
  context: vscode.ExtensionContext,
  overrides: ExtensionOverrides = {}
) {
  const ui = new VscodeLoginUi();
  const store = new CredentialStore(context.secrets, context.globalState);
  const connection = new ConnectionManager({
    ui,
    store,
    settings: currentSettings,
    connect: overrides.connect,
  });

  const opened = new OpenedBoards(context.globalState);
  const tree = new BoardsTreeProvider(connection, opened, () => currentSettings().searchMaxSaved);
  const articles = new ArticleContentProvider(
    () => connection.service,
    (message) => ui.showError(message)
  );
  const statusBar = new StatusBarController(connection);
  const output = vscode.window.createOutputChannel('PTT');
  setErrorLogger((text) => output.appendLine(text));

  const showLoggedInContext = () =>
    vscode.commands.executeCommand('setContext', 'vscptt.loggedIn', connection.state === 'ready');
  void showLoggedInContext();

  context.subscriptions.push(
    output,
    { dispose: () => setErrorLogger(undefined) },
    connection,
    tree,
    articles,
    statusBar,
    connection.onDidChangeState(() => void showLoggedInContext()),
    vscode.window.createTreeView('vscptt.boards', {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
    vscode.workspace.registerTextDocumentContentProvider(ARTICLE_SCHEME, articles),
    ...registerCommands({ connection, tree, articles, opened, store, ui })
  );

  void connection.autoLogin().catch(() => undefined);
  const created = { connection, tree, articles, opened, store, ui, statusBar };
  active = created;
  return created;
}

let active: { connection: ConnectionManager } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  createExtension(context);
}

/** VS Code waits for this, so the connection is logged out politely instead of just dropped. */
export function deactivate(): Promise<void> | undefined {
  return active?.connection.shutdown();
}
