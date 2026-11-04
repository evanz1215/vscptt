import * as vscode from 'vscode';
import type { LoginUi, RememberChoice } from './connection';
import type { SavedLogin } from './credentialStore';

const USERNAME = /^[A-Za-z][A-Za-z0-9]{1,11}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

const KICK = '登出對方並登入';
const RECONNECT = '重新連線';

const REMEMBER_PASSWORD = '記住帳號和密碼（存在 VS Code 的安全儲存空間）';
const REMEMBER_USERNAME = '只記住帳號';
const REMEMBER_NOTHING = '都不記住';

/** The real dialogs. Kept free of logic so everything that matters can be tested through the LoginUi interface. */
export class VscodeLoginUi implements LoginUi {
  async askCredentials(
    saved: SavedLogin | undefined
  ): Promise<{ username: string; password: string } | undefined> {
    const username = await vscode.window.showInputBox({
      title: '登入 PTT',
      prompt: 'PTT 帳號',
      value: saved?.username,
      ignoreFocusOut: true,
      validateInput: (v) =>
        USERNAME.test(v) ? undefined : '帳號是 2 到 12 個英文字母或數字，並以英文字母開頭',
    });
    if (username === undefined) {
      return undefined;
    }
    const password = await vscode.window.showInputBox({
      title: '登入 PTT',
      prompt: `${username} 的密碼`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) =>
        v === '' || CONTROL.test(v) ? '密碼不能是空的，也不能含控制字元' : undefined,
    });
    return password === undefined ? undefined : { username, password };
  }

  async askRemember(): Promise<RememberChoice> {
    const pick = await vscode.window.showQuickPick(
      [REMEMBER_PASSWORD, REMEMBER_USERNAME, REMEMBER_NOTHING],
      {
        placeHolder: '要記住這次的登入資訊嗎？之後可以用「清除已儲存的帳密」刪掉',
        ignoreFocusOut: true,
      }
    );
    if (pick === undefined) {
      return 'cancel'; // Esc must not delete what was saved before
    }
    return pick === REMEMBER_PASSWORD
      ? 'password'
      : pick === REMEMBER_USERNAME
        ? 'usernameOnly'
        : 'no';
  }

  async confirmKickOther(): Promise<boolean> {
    const answer = await vscode.window.showWarningMessage(
      '這個帳號已在別處登入（可能是你的另一台裝置，或上次沒有正常登出的連線）。\n要登出另一條連線並繼續嗎？對方會被登出。',
      { modal: true },
      KICK
    );
    return answer === KICK;
  }

  showError(message: string): void {
    void vscode.window.showErrorMessage(`PTT：${message}`);
  }

  showInfo(message: string): void {
    void vscode.window.showInformationMessage(`PTT：${message}`);
  }

  async notifyDisconnected(): Promise<'reconnect' | undefined> {
    const answer = await vscode.window.showWarningMessage('與 PTT 的連線已中斷。', RECONNECT);
    return answer === RECONNECT ? 'reconnect' : undefined;
  }
}
