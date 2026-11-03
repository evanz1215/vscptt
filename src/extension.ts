import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('vscptt.hello', () => {
      vscode.window.showInformationMessage('vscptt is running');
    })
  );
}

export function deactivate() {}
