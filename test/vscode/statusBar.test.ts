import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from '../mocks/vscode';
import { StatusBarController, describeConnection } from '../../src/vscode/statusBar';
import { makeHarness } from './helpers';

beforeEach(() => mock.reset());

describe('describeConnection', () => {
  it('says logged out, and a click logs in', () => {
    expect(describeConnection('disconnected')).toMatchObject({
      text: expect.stringContaining('未登入'),
      command: 'vscptt.login',
    });
  });

  it('says connecting, and a click opens the options', () => {
    expect(describeConnection('connecting')).toMatchObject({
      text: expect.stringContaining('連線中'),
      command: 'vscptt.statusMenu',
    });
  });

  it('shows the account name when logged in', () => {
    const model = describeConnection('ready', 'alice');
    expect(model.text).toContain('alice');
    expect(model.command).toBe('vscptt.statusMenu');
  });
});

describe('StatusBarController', () => {
  it('shows an item that follows the connection', async () => {
    const h = makeHarness();
    const bar = new StatusBarController(h.manager);
    const item = mock.statusItems[0]!;

    expect(item.visible).toBe(true);
    expect(item.text).toContain('未登入');
    expect(item.command).toBe('vscptt.login');

    await h.manager.login();
    expect(item.text).toContain('alice');
    expect(item.command).toBe('vscptt.statusMenu');

    await h.manager.logout();
    expect(item.text).toContain('未登入');

    bar.dispose();
    expect(item.disposed).toBe(true);
  });

  it('stops following once disposed', async () => {
    const h = makeHarness();
    const bar = new StatusBarController(h.manager);
    const item = mock.statusItems[0]!;
    bar.dispose();
    await h.manager.login();
    expect(item.text).toContain('未登入'); // unchanged
  });
});
