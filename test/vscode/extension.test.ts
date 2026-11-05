import { existsSync, readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import { createExtension, deactivate } from '../../src/extension';
import type { ArticleSummary } from '../../src/core/models';
import type { BoardsTreeProvider, TreeNode } from '../../src/vscode/boardsTree';
import { DEFAULT_SETTINGS, SETTING_KEYS } from '../../src/vscode/settings';
import { FakeBbs, type FakeArticle, type FakeBbsOptions } from '../fakes/fakeBbs';
import type { FakeTransport } from '../fakes/fakeTransport';
import { mock } from '../mocks/vscode';

const REMEMBER_PASSWORD = '記住帳號和密碼（存在 VS Code 的安全儲存空間）';
const REMEMBER_NOTHING = '都不記住';
const KICK = '登出對方並登入';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

function articles(): FakeArticle[] {
  const list: FakeArticle[] = Array.from({ length: 30 }, (_, i) => ({
    id: `M.${i + 1}.A.001`,
    author: `user${i % 5}`,
    title: `[測試] 第${i + 1}篇`,
    body: [`body of ${i + 1}`],
    pushes: [{ kind: '推' as const, user: 'bob', text: 'nice' }],
  }));
  list[9] = { ...list[9]!, kind: 'deleted' };
  list.push({ id: 'M.99.A.001', author: 'mod', title: '[公告] 置頂', pinned: true });
  return list;
}

function boot(bbsOptions: FakeBbsOptions = {}) {
  mock.reset();
  mock.config.set('vscptt.connection.keepAliveSeconds', 0);

  const servers: FakeBbs[] = [];
  const transports: FakeTransport[] = [];
  const secrets = new Map<string, string>();
  const state = new Map<string, unknown>();
  const context = {
    subscriptions: [] as Array<{ dispose(): unknown }>,
    secrets: {
      get: async (k: string) => secrets.get(k),
      store: async (k: string, v: string) => void secrets.set(k, v),
      delete: async (k: string) => void secrets.delete(k),
    },
    globalState: {
      get: <T>(k: string) => state.get(k) as T | undefined,
      update: async (k: string, v: unknown) =>
        void (v === undefined ? state.delete(k) : state.set(k, v)),
    },
  } as unknown as vscode.ExtensionContext;

  const extension = createExtension(context, {
    connect: async () => {
      const server = new FakeBbs({
        boards: { Dev: articles() },
        favorites: ['Dev'],
        ...bbsOptions,
      });
      const transport = server.connect();
      servers.push(server);
      transports.push(transport);
      return transport;
    },
  });

  const tree = mock.treeViews[0]!.provider as BoardsTreeProvider;
  const run = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(id, ...args);
  const login = async (password = 'secret', remember = REMEMBER_NOTHING) => {
    mock.inputAnswers.push('alice', password);
    mock.quickPickAnswers.push(remember);
    await run('vscptt.login');
  };
  const itemOf = (node: TreeNode) => tree.getTreeItem(node);
  const invoke = (node: TreeNode) => {
    const command = itemOf(node).command!;
    return run(command.command, ...(command.arguments ?? []));
  };

  return {
    extension,
    context,
    servers,
    transports,
    secrets,
    state,
    tree,
    run,
    login,
    itemOf,
    invoke,
  };
}

afterEach(async () => {
  await deactivate();
});

describe('what package.json declares matches what the code does', () => {
  it('registers exactly the commands that are declared', () => {
    boot();
    const declared = manifest.contributes.commands
      .map((c: { command: string }) => c.command)
      .sort();
    expect([...mock.commands.keys()].sort()).toEqual(declared);
  });

  it('registers the image hover for article documents only', () => {
    boot();
    expect(mock.hoverProviders.map((h) => h.scheme)).toEqual(['vscptt']);
  });

  it('only puts declared commands in menus', () => {
    const declared = new Set(
      manifest.contributes.commands.map((c: { command: string }) => c.command)
    );
    const used: string[] = Object.values(
      manifest.contributes.menus as Record<string, Array<{ command: string }>>
    )
      .flat()
      .map((m) => m.command);
    expect(used.length).toBeGreaterThan(0);
    for (const command of used) {
      expect(declared.has(command), command).toBe(true);
    }
  });

  it('declares every setting the code reads, with the same default', () => {
    const properties = manifest.contributes.configuration.properties as Record<
      string,
      { default: unknown }
    >;
    expect(Object.keys(properties).sort()).toEqual(SETTING_KEYS.map((k) => `vscptt.${k}`).sort());
    const defaults: Record<string, unknown> = {
      'login.duplicateSession': DEFAULT_SETTINGS.duplicateSession,
      'login.autoLogin': DEFAULT_SETTINGS.autoLogin,
      'connection.settleMs': DEFAULT_SETTINGS.settleMs,
      'connection.stepTimeoutMs': DEFAULT_SETTINGS.stepTimeoutMs,
      'connection.keepAliveSeconds': DEFAULT_SETTINGS.keepAliveSeconds,
      'cache.latestPageSeconds': DEFAULT_SETTINGS.cache.latestPageSeconds,
      'cache.olderPageSeconds': DEFAULT_SETTINGS.cache.olderPageSeconds,
      'cache.articleSeconds': DEFAULT_SETTINGS.cache.articleSeconds,
      'cache.favoritesSeconds': DEFAULT_SETTINGS.cache.favoritesSeconds,
    };
    for (const [key, value] of Object.entries(defaults)) {
      expect(properties[`vscptt.${key}`]!.default, key).toEqual(value);
    }
  });

  it('declares the view the code creates, inside the container, with an icon that exists', () => {
    boot();
    expect(mock.treeViews.map((v) => v.id)).toEqual(['vscptt.boards']);
    expect(manifest.contributes.views.vscptt.map((v: { id: string }) => v.id)).toContain(
      'vscptt.boards'
    );
    const container = manifest.contributes.viewsContainers.activitybar[0];
    expect(container.id).toBe('vscptt');
    expect(existsSync(container.icon)).toBe(true);
  });

  it('is activated at startup and points at the built file', () => {
    expect(manifest.activationEvents).toContain('onStartupFinished');
    expect(manifest.main).toBe('./out/extension.js');
  });

  it('keeps the commands that need an argument out of the command palette', () => {
    const hidden = (
      manifest.contributes.menus.commandPalette as Array<{ command: string; when: string }>
    )
      .filter((m) => m.when === 'false')
      .map((m) => m.command)
      .sort();
    expect(hidden).toEqual([
      'vscptt.copyArticleId',
      'vscptt.copyArticleUrl',
      'vscptt.loadMore',
      'vscptt.openArticle',
      'vscptt.openArticleInBrowser',
      'vscptt.removeSearch',
    ]);
  });
});

describe('using it, start to finish', () => {
  it('logs in, browses a board, reads an article, copies its address, and logs out', async () => {
    const t = boot();
    expect(mock.statusItems[0]!.text).toContain('未登入');
    expect(await t.tree.getChildren()).toEqual([{ kind: 'login', connecting: false }]);

    await t.login();

    expect(mock.contexts.get('vscptt.loggedIn')).toBe(true);
    expect(mock.statusItems[0]!.text).toContain('alice');

    const [favorites] = await t.tree.getChildren();
    const [dev] = await t.tree.getChildren(favorites);
    expect(dev).toMatchObject({ kind: 'board', board: 'Dev' });

    const children = await t.tree.getChildren(dev);
    expect(children[0]).toMatchObject({ kind: 'pinned' });
    expect(children.filter((n) => n.kind === 'article')).toHaveLength(19); // 20 rows, 1 is pinned
    expect(children.at(-1)).toMatchObject({ kind: 'loadMore' });

    // open the newest article
    const newest = children.find((n) => n.kind === 'article')!;
    await t.invoke(newest);
    expect(mock.shownTexts).toHaveLength(1);
    expect(mock.shownTexts[0]).toContain('標題：[測試] 第30篇');
    expect(mock.shownTexts[0]).toContain('body of 30');
    expect(mock.shownTexts[0]).toContain('推 bob: nice');

    // copy its address
    await t.run('vscptt.copyArticleUrl', newest);
    expect(mock.clipboard).toBe('https://www.ptt.cc/bbs/Dev/M.30.A.001.html');
    await t.run('vscptt.copyArticleId', newest);
    expect(mock.clipboard).toMatch(/^#1/);

    // and open it in the browser: the address is checked, then handed over once
    await t.run('vscptt.openArticleInBrowser', newest);
    expect(mock.externalLinks).toEqual(['https://www.ptt.cc/bbs/Dev/M.30.A.001.html']);

    // load older articles through the node's own command
    await t.invoke(children.at(-1)!);
    const more = await t.tree.getChildren(dev);
    expect(more.filter((n) => n.kind === 'article')).toHaveLength(30);
    expect(more.some((n) => n.kind === 'loadMore')).toBe(false);

    await t.run('vscptt.logout');
    expect(mock.contexts.get('vscptt.loggedIn')).toBe(false);
    expect(mock.statusItems[0]!.text).toContain('未登入');
    expect(t.transports[0]!.sent.slice(-3)).toEqual(['G\r', 'Y\r', ' ']);
  });

  it('reads a pinned article', async () => {
    const t = boot();
    await t.login();
    const [favorites] = await t.tree.getChildren();
    const [dev] = await t.tree.getChildren(favorites);
    const [pinnedGroup] = await t.tree.getChildren(dev);
    const [pinned] = await t.tree.getChildren(pinnedGroup);

    await t.invoke(pinned!);

    expect(mock.shownTexts[0]).toContain('標題：[公告] 置頂');
    expect(mock.shownTexts[0]).not.toContain('無法開啟');
  });

  it('opens a board by name, remembers it, and refuses one that does not exist', async () => {
    const t = boot();
    await t.login();

    mock.inputAnswers.push('Dev');
    await t.run('vscptt.openBoard');
    expect(t.extension.opened.list()).toEqual(['Dev']);
    expect(mock.messages.at(-1)!.message).toContain('已加入');

    mock.inputAnswers.push('NoSuchBoardZ');
    await t.run('vscptt.openBoard');
    expect(t.extension.opened.list()).toEqual(['Dev']);
    const last = mock.messages.at(-1)!;
    expect(last.level).toBe('error');
    expect(last.message).toContain('找不到看板');

    const [, opened] = await t.tree.getChildren();
    expect(
      (await t.tree.getChildren(opened)).map((n) => (n.kind === 'board' ? n.board : ''))
    ).toEqual(['Dev']);
  });

  it('asks for a valid board name before sending anything', async () => {
    const t = boot();
    await t.login();
    const sent = t.transports[0]!.sent.length;
    mock.inputAnswers.push(undefined as unknown as string); // the user cancels the box
    await t.run('vscptt.openBoard');
    expect(t.transports[0]!.sent.length).toBe(sent);
  });

  it('does not touch the server for an article that was deleted', async () => {
    const t = boot();
    await t.login();
    const deleted: ArticleSummary = {
      board: 'Dev',
      listNumber: 10,
      isPinned: false,
      title: '(本文已被刪除)',
      author: '-',
      date: '10/25',
      push: '',
      mark: '',
      kind: 'deleted',
    };
    const sent = t.transports[0]!.sent.length;

    await t.run('vscptt.openArticle', deleted);

    expect(t.transports[0]!.sent.length).toBe(sent);
    expect(mock.shownDocuments).toEqual([]);
    expect(mock.messages.at(-1)!.message).toContain('已被刪除');
  });

  it('shows a failure inside the tab when the list has changed under it', async () => {
    const t = boot();
    await t.login();
    const [favorites] = await t.tree.getChildren();
    const [dev] = await t.tree.getChildren(favorites);
    const children = await t.tree.getChildren(dev);
    const summary = (children.find((n) => n.kind === 'article') as { summary: ArticleSummary })
      .summary;

    // someone deletes an older article, so every number below it moves
    t.servers[0]!.mutate('Dev', (list) => void list.splice(0, 1));
    await t.run('vscptt.openBoard', undefined); // (input box cancelled) leaves the session as it is
    mock.inputAnswers.push('Dev');
    await t.run('vscptt.openBoard'); // re-enter the board so the fake shows the new numbering

    await t.run('vscptt.openArticle', { ...summary, title: '[測試] 第30篇' });

    expect(mock.shownTexts.at(-1)).toContain('無法開啟這篇文章');
    expect(
      mock.messages.some((m) => m.level === 'error' && m.message.includes('清單已經變動'))
    ).toBe(true);
  });

  it('ignores arguments that are not what the tree sends', async () => {
    const t = boot();
    await t.login();
    const sent = t.transports[0]!.sent.length;
    for (const bad of [undefined, null, 'x', 5, {}, { board: 5 }, []]) {
      await t.run('vscptt.openArticle', bad);
      await t.run('vscptt.copyArticleId', bad);
      await t.run('vscptt.copyArticleUrl', bad);
    }
    for (const bad of [undefined, 5, '../x', 'a b', {}]) {
      await t.run('vscptt.loadMore', bad);
    }
    expect(t.transports[0]!.sent.length).toBe(sent);
    expect(mock.shownDocuments).toEqual([]);
  });

  it('asks to log in first when an article is opened while logged out, and stops if the user declines', async () => {
    const t = boot();
    const summary: ArticleSummary = {
      board: 'Dev',
      listNumber: 3,
      isPinned: false,
      title: 't',
      author: 'a',
      date: '11/01',
      push: '',
      mark: '',
      kind: 'normal',
    };
    await t.run('vscptt.openArticle', summary); // no answer queued: the credential box is cancelled
    expect(mock.inputBoxes).toHaveLength(1);
    expect(t.transports).toHaveLength(0);
    expect(mock.shownDocuments).toEqual([]);
  });
});

describe('the account is already logged in somewhere else', () => {
  it('logs the other connection out only when the user presses the button', async () => {
    const t = boot({ duplicateLogin: true });
    mock.messageAnswers.push(KICK);
    await t.login();
    expect(t.servers[0]!.duplicateAnswer).toBe('y');
    const dialog = mock.messages.find((m) => m.items.includes(KICK))!;
    expect(dialog.level).toBe('warning');
    expect(dialog.message).toContain('對方會被登出');
  });

  it('keeps the other connection when the dialog is dismissed, and explains the failed login', async () => {
    const t = boot({ duplicateLogin: true });
    await t.login(); // no answer queued: dismissed
    expect(t.servers[0]!.duplicateAnswer).toBe('n');
    expect(mock.statusItems[0]!.text).toContain('未登入');
    expect(
      mock.messages.some((m) => m.level === 'error' && m.message.includes('已在別處登入'))
    ).toBe(true);
  });
});

describe('credentials', () => {
  const SECRET = 'hunter2-secret-pw';

  /** Everything a user could read or copy, gathered from the stand-in VS Code. */
  async function everythingVisible(t: ReturnType<typeof boot>): Promise<string> {
    const [favorites] = await t.tree.getChildren();
    const nodes = [favorites!, ...(await t.tree.getChildren(favorites))];
    const items = nodes.map((n) => {
      const i = t.itemOf(n);
      return [i.label, i.description, i.tooltip, i.id];
    });
    return JSON.stringify([
      mock.messages,
      mock.inputBoxes.map((b) => [b.prompt, b.value]),
      mock.quickPickCalls,
      mock.clipboard,
      mock.statusItems.map((s) => [s.text, s.tooltip, s.command]),
      mock.shownTexts,
      mock.executed,
      items,
    ]);
  }

  it('never shows the password anywhere, and types it exactly once', async () => {
    const t = boot({ users: { alice: SECRET } });
    await t.login(SECRET);

    expect(t.extension.connection.state).toBe('ready');
    expect(await everythingVisible(t)).not.toContain(SECRET);
    expect(t.transports[0]!.sent.filter((k) => k.includes(SECRET))).toEqual([`${SECRET}\r`]);
  });

  it('shows no password after a failed login either', async () => {
    const t = boot({ users: { alice: 'something-else' } });
    await t.login(SECRET);
    expect(t.extension.connection.state).toBe('disconnected');
    expect(mock.messages.map((m) => m.message).join('\n')).not.toContain(SECRET);
    expect(mock.messages.some((m) => m.message.includes('帳號或密碼錯誤'))).toBe(true);
  });

  it('keeps the password only in secret storage, and only if the user chose to', async () => {
    const asked = boot({ users: { alice: SECRET } });
    await asked.login(SECRET, REMEMBER_PASSWORD);
    expect([...asked.secrets.values()]).toEqual([SECRET]);
    expect(JSON.stringify([...asked.state.entries()])).not.toContain(SECRET);

    const declined = boot({ users: { alice: SECRET } });
    await declined.login(SECRET, REMEMBER_NOTHING);
    expect(declined.secrets.size).toBe(0);
  });

  it('clear credentials forgets them, after a confirmation', async () => {
    const t = boot({ users: { alice: SECRET } });
    await t.login(SECRET, REMEMBER_PASSWORD);

    await t.run('vscptt.clearCredentials'); // dialog dismissed: nothing happens
    expect(t.secrets.size).toBe(1);

    mock.messageAnswers.push('清除');
    await t.run('vscptt.clearCredentials');
    expect(t.secrets.size).toBe(0);
    expect(await t.extension.store.load()).toBeUndefined();
  });
});

describe('shutting down', () => {
  it('logs out politely when VS Code deactivates the extension', async () => {
    const t = boot();
    await t.login();
    await deactivate();
    expect(t.transports[0]!.sent.slice(-3)).toEqual(['G\r', 'Y\r', ' ']);
  });

  it('removes its commands, view and status item when disposed', async () => {
    const t = boot();
    for (const d of t.context.subscriptions) {
      d.dispose();
    }
    expect(mock.commands.size).toBe(0);
    expect(mock.contentProviders.size).toBe(0);
    expect(mock.statusItems[0]!.disposed).toBe(true);
  });
});

describe('searching a board', () => {
  const hits = (): FakeArticle[] => [
    { id: 'M.1.A.001', author: 'bob', title: '[討論] 人月神話', body: ['mythical'] },
    { id: 'M.2.A.002', author: 'amy', title: '[閒聊] 午餐', body: ['lunch'] },
    { id: 'M.3.A.003', author: 'bob', title: '[心得] 人月神話 讀後感', body: ['review'] },
  ];
  const board = { kind: 'board', group: 'opened', board: 'Dev' } as const;
  const searchGroup = (nodes: TreeNode[]) =>
    nodes.find((n) => n.kind === 'group' && n.group === 'search');

  it('asks what to search, shows the matches in their own group, and opens the clicked one', async () => {
    const h = boot({ boards: { Dev: hits() } });
    await h.login();

    mock.quickPickAnswers.push('標題關鍵字');
    mock.inputAnswers.push('人月');
    await h.run('vscptt.search', board);

    const group = searchGroup(await h.tree.getChildren())!;
    expect(group).toBeDefined();
    const [search] = await h.tree.getChildren(group);
    expect(String(h.itemOf(search!).label)).toBe('Dev：標題「人月」');
    const found = await h.tree.getChildren(search);
    expect(found.map((n) => (n.kind === 'article' ? n.summary.title : ''))).toEqual([
      '[心得] 人月神話 讀後感',
      '[討論] 人月神話',
    ]);

    await h.invoke(found[0]!); // the newest hit
    expect(mock.shownTexts).toHaveLength(1);
    expect(mock.shownTexts[0]).toContain('review');
    expect(mock.shownTexts[0]).not.toContain('無法');
  });

  it('says so when nothing matches, and adds nothing to the tree', async () => {
    const h = boot({ boards: { Dev: hits() } });
    await h.login();
    mock.quickPickAnswers.push('作者');
    mock.inputAnswers.push('nobody');
    await h.run('vscptt.search', board);

    expect(mock.messages.some((m) => m.message.includes('沒有符合'))).toBe(true);
    expect(searchGroup(await h.tree.getChildren())).toBeUndefined();
  });

  it('asks for the board when started from the toolbar, and does nothing when the user backs out', async () => {
    const h = boot({ boards: { Dev: hits() } });
    await h.login();

    mock.inputAnswers.push(undefined);
    await h.run('vscptt.search');
    expect(h.servers[0]!.searches).toEqual([]);

    mock.inputAnswers.push('Dev');
    mock.quickPickAnswers.push(undefined);
    await h.run('vscptt.search');
    expect(h.servers[0]!.searches).toEqual([]);
  });

  it('never sends text the prompt must not receive', async () => {
    const h = boot({ boards: { Dev: hits() } });
    await h.login();
    mock.quickPickAnswers.push('標題關鍵字');
    mock.inputAnswers.push('a\rb'); // what a paste can do even though the box would flag it
    await h.run('vscptt.search', board);

    expect(h.servers[0]!.searches).toEqual([]);
    const validate = mock.inputBoxes.at(-1)!.validateInput!;
    expect(validate('a\rb')).toBeTruthy();
    expect(validate('人月')).toBeUndefined();
  });

  it('can remove a search again with the command of its node', async () => {
    const h = boot({ boards: { Dev: hits() } });
    await h.login();
    mock.quickPickAnswers.push('標題關鍵字');
    mock.inputAnswers.push('人月');
    await h.run('vscptt.search', board);
    const [search] = await h.tree.getChildren(searchGroup(await h.tree.getChildren())!);

    await h.run('vscptt.removeSearch', search);

    expect(searchGroup(await h.tree.getChildren())).toBeUndefined();
  });
});
