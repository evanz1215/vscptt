import { describe, expect, it } from 'vitest';
import {
  ArticleMismatchError,
  ArticleNotFoundError,
  BoardNotFoundError,
  ConnectionClosedError,
  DuplicateLoginDeclinedError,
  InvalidArgumentError,
  LoginFailedError,
  NotLoggedInError,
  TooFrequentError,
  UnexpectedScreenError,
} from '../../src/core/errors';
import { WaitTimeoutError } from '../../src/core/queue/waitFor';
import { SshConnectError } from '../../src/core/transport/sshTransport';
import { describeError } from '../../src/vscode/errorMessages';

describe('describeError', () => {
  const cases: Array<[string, unknown, string]> = [
    ['wrong password', new LoginFailedError('wrongPassword'), '帳號或密碼錯誤'],
    ['no such account', new LoginFailedError('noAccount'), '找不到這個帳號'],
    ['too frequent', new TooFrequentError(), '登入太頻繁'],
    ['duplicate login refused', new DuplicateLoginDeclinedError(), '已在別處登入'],
    ['connection closed', new ConnectionClosedError(), '連線已中斷'],
    ['board not found', new BoardNotFoundError('Dev'), '找不到看板「Dev」'],
    ['article mismatch', new ArticleMismatchError('whatever'), '清單已經變動'],
    ['article not found', new ArticleNotFoundError(), '找不到這篇文章'],
    ['not logged in', new NotLoggedInError(), '尚未登入'],
    [
      'ssh host key refused',
      new SshConnectError('x', 'SHA256:abc'),
      '主機金鑰（SHA256:abc）和上次記住的不同',
    ],
    ['ssh unreachable', new SshConnectError('x'), '22 埠'],
    ['timeout', new WaitTimeoutError('the article text', 10, []), '逾時（等待：the article text）'],
  ];
  it.each(cases)('%s', (_name, error, expected) => {
    expect(describeError(error)).toContain(expected);
  });

  it('says in Chinese that the input was refused, then gives our validation message', () => {
    expect(describeError(new InvalidArgumentError('Not a list number: 0'))).toBe(
      '輸入的內容不符合規則：Not a list number: 0'
    );
  });

  it('never repeats the screen snapshot an error carries', () => {
    const error = new UnexpectedScreenError('x', ['SECRET-SCREEN-TEXT']);
    expect(describeError(error)).not.toContain('SECRET-SCREEN-TEXT');
  });

  it('describes an unknown failure without dumping a huge message', () => {
    const text = describeError(new Error('x'.repeat(1000)));
    expect(text.startsWith('發生未預期的錯誤：')).toBe(true);
    expect(text.length).toBeLessThan(260);
    expect(describeError('plain string')).toContain('plain string');
  });
});

describe('a timeout leaves the screen it was looking at in the output channel', () => {
  it('writes the step and the masked screen to the log, not to the message', async () => {
    const { setErrorLogger } = await import('../../src/vscode/errorMessages');
    const written: string[] = [];
    setErrorLogger((t) => written.push(t));
    try {
      const message = describeError(
        new WaitTimeoutError('the article', 5000, ['line one', 'line two'])
      );
      expect(written.join('')).toContain('the article');
      expect(written.join('')).toContain('line two');
      expect(message).not.toContain('line two');
    } finally {
      setErrorLogger(undefined);
    }
  });
});
