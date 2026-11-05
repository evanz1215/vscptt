import { PttError } from '../core/errors';
import { WaitTimeoutError } from '../core/queue/waitFor';
import { SshConnectError } from '../core/transport/sshTransport';
import { WsConnectError } from '../core/transport/wsTransport';

let logger: ((text: string) => void) | undefined;

/** Where to write the screen a timed-out step was looking at (the "PTT" output channel). */
export function setErrorLogger(write: ((text: string) => void) | undefined): void {
  logger = write;
}

/**
 * A short Traditional Chinese sentence for an error, safe to show to the user. It never includes the screen
 * snapshots some errors carry, and never repeats text that came from the BBS.
 */
export function describeError(error: unknown): string {
  if (error instanceof WaitTimeoutError) {
    // The screen is already masked (IP addresses, account name). It goes to the output channel only, never into a message.
    const header = `[${new Date().toISOString()}] 逾時：${error.description}（${error.timeoutMs} ms）`;
    logger?.([header, ...error.snapshot].join('\n'));
    // The step names are written by this project (never BBS text), so they are safe to show and tell us where it hung.
    return `等待 PTT 回應逾時（等待：${error.description}），請稍後再試。`;
  }
  if (error instanceof WsConnectError) {
    const status = error.statusCode ? `（HTTP ${error.statusCode}）` : '';
    return `無法連線到 PTT${status}，請檢查網路後再試。`;
  }
  if (error instanceof SshConnectError) {
    return error.hostKeyFingerprint
      ? `PTT 的 SSH 主機金鑰（${error.hostKeyFingerprint}）和上次記住的不同，已拒絕連線。可能是站方更換了金鑰，也可能有人在攔截連線；確認是站方更換後，執行「PTT: 忘記 SSH 主機金鑰」再連線。`
      : '無法以 SSH 連線到 PTT，請檢查網路（有些網路會擋 22 埠）後再試，或在設定改用 WebSocket。';
  }
  if (error instanceof PttError) {
    switch (error.code) {
      case 'loginFailed':
        return (error as { reason?: string }).reason === 'noAccount'
          ? '找不到這個帳號，請確認帳號是否正確。'
          : '帳號或密碼錯誤。';
      case 'tooFrequent':
        return 'PTT 暫時拒絕登入（登入太頻繁），請等幾分鐘再試。';
      case 'duplicateLogin':
        return '這個帳號已在別處登入，且保留了那條連線，所以 PTT 拒絕了這次登入。';
      case 'connectionClosed':
        return '與 PTT 的連線已中斷。';
      case 'boardNotFound':
        return `找不到看板「${(error as { board?: string }).board ?? ''}」，或沒有權限進入。`;
      case 'articleDeleted':
        return '這篇文章已被刪除，沒有內容可以顯示。';
      case 'articleNotFound':
        return '這個看板裡找不到這篇文章，可能已被刪除、移走，或看板名稱不對。';
      case 'articleMismatch':
        return '看板清單已經變動，無法確認打開的是同一篇文章。請重新整理看板後再試。';
      case 'unexpectedScreen':
        return 'PTT 的畫面和預期不同，已回到主選單。請再試一次。';
      case 'notLoggedIn':
        return '尚未登入 PTT。';
      case 'invalidArgument':
        return `輸入的內容不符合規則：${error.message}`; // our own validation messages, in English
    }
  }
  const text = error instanceof Error ? error.message : String(error);
  return `發生未預期的錯誤：${text.slice(0, 200)}`;
}
