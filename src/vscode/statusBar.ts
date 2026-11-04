import * as vscode from 'vscode';
import type { ConnectionManager, ConnectionState } from './connection';

export interface StatusModel {
  text: string;
  tooltip: string;
  /** The command a click runs. */
  command: string;
}

/** What the status bar item says for a connection state. */
export function describeConnection(state: ConnectionState, username?: string): StatusModel {
  switch (state) {
    case 'connecting':
      return {
        text: '$(sync~spin) PTT：連線中…',
        tooltip: '正在連線並登入 PTT',
        command: 'vscptt.statusMenu',
      };
    case 'ready':
      return {
        text: `$(account) PTT：${username ?? ''}`,
        tooltip: '已登入 PTT。點擊查看連線選項',
        command: 'vscptt.statusMenu',
      };
    case 'disconnected':
      return { text: '$(plug) PTT：未登入', tooltip: '點擊登入 PTT', command: 'vscptt.login' };
  }
}

/** Keeps one status bar item in step with the connection. */
export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly connection: ConnectionManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'PTT';
    this.update();
    this.item.show();
    this.subscription = connection.onDidChangeState(() => this.update());
  }

  private update(): void {
    const model = describeConnection(this.connection.state, this.connection.username);
    this.item.text = model.text;
    this.item.tooltip = model.tooltip;
    this.item.command = model.command;
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
