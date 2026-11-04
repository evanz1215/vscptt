import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { ConnectionClosedError } from '../../src/core/errors';
import { BoardsTreeProvider, type TreeNode } from '../../src/vscode/boardsTree';
import { OpenedBoards } from '../../src/vscode/openedBoards';
import { FakeTreeConnection, page, pinnedSummary, summary } from './treeHelpers';

function setup(opened: string[] = []) {
  const connection = new FakeTreeConnection();
  const memento = new Map<string, unknown>([['vscptt.openedBoards', opened]]);
  const store = new OpenedBoards({
    get: <T>(k: string) => memento.get(k) as T | undefined,
    update: async (k, v) => void memento.set(k, v),
  });
  const tree = new BoardsTreeProvider(connection, store);
  const board = (group: 'favorites' | 'opened' = 'favorites', name = 'Dev'): TreeNode => ({
    kind: 'board',
    group,
    board: name,
  });
  const labels = async (node?: TreeNode) =>
    (await tree.getChildren(node)).map((n) => String(tree.getTreeItem(n).label));
  return { connection, tree, opened: store, board, labels };
}

describe('root', () => {
  it('shows only a login node while logged out, with a command to log in', async () => {
    const { connection, tree } = setup();
    connection.state = 'disconnected';
    const [node] = await tree.getChildren();
    const item = tree.getTreeItem(node!);
    expect(item.label).toBe('登入 PTT…');
    expect(item.command?.command).toBe('vscptt.login');
  });

  it('shows a plain "connecting" node without a command while connecting', async () => {
    const { connection, tree } = setup();
    connection.state = 'connecting';
    const [node] = await tree.getChildren();
    const item = tree.getTreeItem(node!);
    expect(item.label).toBe('連線中…');
    expect(item.command).toBeUndefined();
  });

  it('shows the favorites and opened-boards groups once logged in', async () => {
    const { tree, labels } = setup();
    expect(await labels()).toEqual(['我的最愛', '已開啟的看板']);
    const [fav] = await tree.getChildren();
    expect(tree.getTreeItem(fav!).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
  });

  it('redraws and forgets loaded boards when the connection state changes', async () => {
    const { connection, tree } = setup();
    connection.read.pages.set('dev', [page('Dev', [3, 2, 1])]);
    const fired: unknown[] = [];
    tree.onDidChangeTreeData((v) => fired.push(v));
    const board: TreeNode = { kind: 'board', group: 'favorites', board: 'Dev' };

    await tree.getChildren(board);
    connection.setState('disconnected');
    connection.setState('ready');
    await tree.getChildren(board);

    expect(fired).toHaveLength(2);
    expect(connection.read.calls.filter((c) => c.startsWith('getBoardPage'))).toHaveLength(2);
  });
});

describe('favorites and opened boards', () => {
  it('lists the favorite boards with their category', async () => {
    const { connection, tree } = setup();
    connection.read.favorites = [
      { name: 'Dev', category: '工作', title: '[軟工] 討論', unread: true },
      { name: 'Ops', category: '程設', title: 'Ops 板', unread: false },
    ];
    const nodes = await tree.getChildren({ kind: 'group', group: 'favorites' });
    expect(nodes.map((n) => tree.getTreeItem(n).label)).toEqual(['Dev', 'Ops']);
    const item = tree.getTreeItem(nodes[0]!);
    expect(item.description).toBe('工作');
    expect(item.tooltip).toBe('[軟工] 討論');
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect(item.contextValue).toBe('board');
  });

  it('says so when there are no favorites', async () => {
    const { tree } = setup();
    const [node] = await tree.getChildren({ kind: 'group', group: 'favorites' });
    expect(tree.getTreeItem(node!).label).toBe('最愛清單是空的');
  });

  it('turns a failure into a node that retries, never into an empty or broken tree', async () => {
    const { connection, tree } = setup();
    connection.read.failWith = new Error('boom');
    const [node] = await tree.getChildren({ kind: 'group', group: 'favorites' });
    const item = tree.getTreeItem(node!);
    expect(String(item.label)).toContain('發生未預期的錯誤');
    expect(item.command?.command).toBe('vscptt.refresh');
  });

  it('offers to reconnect when the connection is what failed', async () => {
    const { connection, tree } = setup();
    connection.read.failWith = new ConnectionClosedError();
    const [node] = await tree.getChildren({ kind: 'group', group: 'favorites' });
    expect(tree.getTreeItem(node!).command?.command).toBe('vscptt.reconnect');
  });

  it('lists the boards opened by name, or points to the command that opens one', async () => {
    const some = setup(['Soft_Job', 'Stock']);
    expect(await some.labels({ kind: 'group', group: 'opened' })).toEqual(['Soft_Job', 'Stock']);

    const none = setup();
    const [hint] = await none.tree.getChildren({ kind: 'group', group: 'opened' });
    expect(none.tree.getTreeItem(hint!).command?.command).toBe('vscptt.openBoard');
  });
});

describe('a board', () => {
  it('shows pinned posts as a group, then the articles newest first, then "load more"', async () => {
    const { connection, tree, board } = setup();
    connection.read.pages.set('dev', [page('Dev', [30, 29, 28], { pinned: 2, hasOlder: true })]);

    const nodes = await tree.getChildren(board());

    expect(nodes.map((n) => n.kind)).toEqual([
      'pinned',
      'article',
      'article',
      'article',
      'loadMore',
    ]);
    expect(tree.getTreeItem(nodes[0]!).label).toBe('置頂文（2）');
    expect(tree.getTreeItem(nodes[0]!).collapsibleState).toBe(
      vscode.TreeItemCollapsibleState.Collapsed
    );
    expect(nodes.slice(1, 4).map((n) => (n.kind === 'article' ? n.summary.listNumber : 0))).toEqual(
      [30, 29, 28]
    );
  });

  it('has no pinned group and no "load more" when there is nothing of either', async () => {
    const { connection, tree, board } = setup();
    connection.read.pages.set('dev', [page('Dev', [3, 2, 1])]);
    expect((await tree.getChildren(board())).map((n) => n.kind)).toEqual([
      'article',
      'article',
      'article',
    ]);
  });

  it('says so when a board is empty', async () => {
    const { connection, board, labels } = setup();
    connection.read.pages.set('dev', [page('Dev', [])]);
    expect(await labels(board())).toEqual(['這個看板沒有文章']);
  });

  it('shows the pinned posts under the pinned group', async () => {
    const { connection, tree, board } = setup();
    connection.read.pages.set('dev', [page('Dev', [3, 2, 1], { pinned: 2 })]);
    const [group] = await tree.getChildren(board());
    const pinned = await tree.getChildren(group);
    expect(pinned.map((n) => (n.kind === 'article' ? n.summary.title : ''))).toEqual([
      '[公告] 置頂0',
      '[公告] 置頂1',
    ]);
  });

  it('turns a failure into a retry node', async () => {
    const { connection, tree, board } = setup();
    connection.read.failWith = new ConnectionClosedError();
    const [node] = await tree.getChildren(board());
    expect(String(tree.getTreeItem(node!).label)).toContain('連線已中斷');
  });

  it('fetches a board once even when it is expanded twice at the same time, or from both groups', async () => {
    const { connection, tree, board } = setup(['Dev']);
    connection.read.delayMs = 20;
    connection.read.pages.set('dev', [page('Dev', [3, 2, 1])]);

    await Promise.all([tree.getChildren(board('favorites')), tree.getChildren(board('opened'))]);

    expect(connection.read.calls.filter((c) => c.startsWith('getBoardPage'))).toEqual([
      'getBoardPage:Dev:latest',
    ]);
  });
});

describe('article nodes', () => {
  const itemOf = (s = summary(7)) => {
    const { tree } = setup();
    return tree.getTreeItem({ kind: 'article', group: 'favorites', summary: s });
  };

  it('label is the title; description is push count, author and date', () => {
    const item = itemOf(summary(7, { push: '12', author: 'alice', date: '11/03' }));
    expect(item.label).toBe('[測試] 第7篇');
    expect(item.description).toBe('[12] alice 11/03');
  });

  it('leaves out the push count when there is none', () => {
    expect(itemOf(summary(7, { push: '', author: 'alice', date: '11/03' })).description).toBe(
      'alice 11/03'
    );
  });

  it('opens the article with the summary as the argument', () => {
    const s = summary(7);
    const item = itemOf(s);
    expect(item.command).toMatchObject({ command: 'vscptt.openArticle', arguments: [s] });
    expect(item.contextValue).toBe('article');
  });

  it('marks pinned and deleted articles', () => {
    const pinned = itemOf(pinnedSummary(0));
    expect(pinned.contextValue).toBe('article.pinned');
    expect(String(pinned.tooltip)).toContain('置頂文');
    expect((pinned.iconPath as vscode.ThemeIcon).id).toBe('pin');

    const deleted = itemOf(summary(8, { kind: 'deleted' }));
    expect(deleted.contextValue).toBe('article.deleted');
    expect((deleted.iconPath as vscode.ThemeIcon).id).toBe('trash');
    expect(String(deleted.tooltip)).toContain('已被刪除');
  });

  it('gives the same article a different id in each group, so expansion state does not collide', () => {
    const { tree } = setup();
    const a = tree.getTreeItem({ kind: 'article', group: 'favorites', summary: summary(7) });
    const b = tree.getTreeItem({ kind: 'article', group: 'opened', summary: summary(7) });
    expect(a.id).not.toBe(b.id);
  });
});

describe('loading older articles', () => {
  async function twoPages() {
    const ctx = setup();
    ctx.connection.read.pages.set('dev', [
      page('Dev', [30, 29, 28], { hasOlder: true }),
      page('Dev', [27, 26, 25], { hasOlder: true }),
      page('Dev', [24, 23, 22]),
    ]);
    await ctx.tree.getChildren(ctx.board());
    return ctx;
  }

  const numbers = async (ctx: Awaited<ReturnType<typeof twoPages>>) =>
    (await ctx.tree.getChildren(ctx.board()))
      .filter((n) => n.kind === 'article')
      .map((n) => (n.kind === 'article' ? n.summary.listNumber : 0));

  it('appends the next page and redraws', async () => {
    const ctx = await twoPages();
    let fired = 0;
    ctx.tree.onDidChangeTreeData(() => fired++);

    await ctx.tree.loadMore('Dev');

    expect(await numbers(ctx)).toEqual([30, 29, 28, 27, 26, 25]);
    expect(fired).toBe(1);
  });

  it('keeps going to the last page and then offers no more', async () => {
    const ctx = await twoPages();
    await ctx.tree.loadMore('Dev');
    await ctx.tree.loadMore('Dev');
    expect(await numbers(ctx)).toEqual([30, 29, 28, 27, 26, 25, 24, 23, 22]);
    expect((await ctx.tree.getChildren(ctx.board())).some((n) => n.kind === 'loadMore')).toBe(
      false
    );

    await ctx.tree.loadMore('Dev'); // nothing left: harmless
    expect(ctx.connection.read.calls.filter((c) => c.startsWith('getBoardPage'))).toHaveLength(3);
  });

  it('never shows the same article twice', async () => {
    const ctx = setup();
    // The older page repeats 28, as can happen when a post is added while paging.
    ctx.connection.read.pages.set('dev', [
      page('Dev', [30, 29, 28], { hasOlder: true }),
      page('Dev', [27, 28, 26]),
    ]);
    await ctx.tree.getChildren(ctx.board());
    await ctx.tree.loadMore('Dev');

    const shown = (await ctx.tree.getChildren(ctx.board()))
      .filter((n) => n.kind === 'article')
      .map((n) => (n.kind === 'article' ? n.summary.listNumber : 0));
    expect(shown).toEqual([30, 29, 28, 27, 26]);
  });

  it('ignores a load that finishes after the board was refreshed', async () => {
    const ctx = await twoPages();
    ctx.connection.read.delayMs = 30;
    const loading = ctx.tree.loadMore('Dev');
    ctx.tree.refresh('Dev'); // the user refreshed while it was loading
    await loading;
    ctx.connection.read.delayMs = 0;
    expect(await numbers(ctx)).toEqual([30, 29, 28]); // reloaded from the latest page only
  });

  it('reports a failure to the caller instead of swallowing it', async () => {
    const ctx = await twoPages();
    ctx.connection.read.failWith = new ConnectionClosedError();
    await expect(ctx.tree.loadMore('Dev')).rejects.toBeInstanceOf(ConnectionClosedError);
  });
});

describe('refresh', () => {
  it('drops one board, asks the service to forget it, and fetches again on the next expand', async () => {
    const { connection, tree, board } = setup();
    connection.read.pages.set('dev', [page('Dev', [3, 2, 1])]);
    await tree.getChildren(board());

    tree.refresh('Dev');
    await tree.getChildren(board());

    expect(connection.read.calls).toContain('invalidate:Dev');
    expect(connection.read.calls.filter((c) => c.startsWith('getBoardPage'))).toHaveLength(2);
  });

  it('with no board, drops everything', async () => {
    const { connection, tree, board } = setup();
    connection.read.pages.set('dev', [page('Dev', [3, 2, 1])]);
    await tree.getChildren(board());
    tree.refresh();
    expect(connection.read.calls).toContain('invalidate:*');
  });

  it('is harmless while disconnected', () => {
    const { connection, tree } = setup();
    connection.state = 'disconnected';
    expect(() => tree.refresh('Dev')).not.toThrow();
    expect(() => tree.refresh()).not.toThrow();
  });
});

describe('search results', () => {
  const title = { kind: 'title', text: '測試' } as const;
  const author = { kind: 'author', text: 'bob' } as const;
  const results = (board: string, numbers: number[], hasOlder = false) => ({
    ...page(board, numbers, { hasOlder }),
    articles: numbers.map((n) => summary(n, { board, search: title })),
  });

  it('has no search group until a search was added, then lists it as a node under the group', async () => {
    const { tree, labels } = setup();
    expect(await labels()).toEqual(['我的最愛', '已開啟的看板']);

    tree.addSearch('Dev', title, results('Dev', [3, 2, 1]));

    expect(await labels()).toEqual(['我的最愛', '已開啟的看板', '搜尋結果']);
    const group = (await tree.getChildren())[2]!;
    expect(await labels(group)).toEqual(['Dev：標題「測試」']);
  });

  it('shows the first page it was given without asking the server again', async () => {
    const { connection, tree } = setup();
    tree.addSearch('Dev', title, results('Dev', [3, 2, 1]));
    const [node] = await tree.getChildren((await tree.getChildren())[2]!);
    const children = await tree.getChildren(node);
    expect(children.map((n) => n.kind)).toEqual(['article', 'article', 'article']);
    expect(connection.read.calls.filter((c) => c.startsWith('searchBoard'))).toEqual([]);
  });

  it('gives result articles ids that differ from the same numbers in another search or the board', async () => {
    const { tree } = setup();
    tree.addSearch('Dev', title, results('Dev', [2, 1]));
    tree.addSearch('Dev', author, {
      ...results('Dev', [2, 1]),
      articles: [summary(2), summary(1)],
    });
    const group = (await tree.getChildren())[2]!;
    const ids: string[] = [];
    for (const search of await tree.getChildren(group)) {
      for (const article of await tree.getChildren(search)) {
        ids.push(String(tree.getTreeItem(article).id));
      }
    }
    expect(new Set(ids).size).toBe(4);
  });

  it('loads older results with a node that remembers which search it belongs to', async () => {
    const { connection, tree } = setup();
    connection.read.searchPages.set(`dev:${JSON.stringify(title)}`, [
      results('Dev', [30, 29], true),
      results('Dev', [28, 27]),
    ]);
    const id = tree.addSearch('Dev', title, results('Dev', [30, 29], true));
    const [search] = await tree.getChildren((await tree.getChildren())[2]!);

    const before = await tree.getChildren(search);
    const more = before.at(-1)!;
    expect(more.kind).toBe('loadMore');
    const command = tree.getTreeItem(more).command!;
    expect(command.arguments).toEqual(['Dev', id]);

    await tree.loadMoreSearch(id);
    const after = await tree.getChildren(search);
    expect(after.filter((n) => n.kind === 'article')).toHaveLength(4);
    expect(after.some((n) => n.kind === 'loadMore')).toBe(false);
  });

  it('replaces a repeated search instead of listing it twice, and keeps only the newest few', async () => {
    const connection = new FakeTreeConnection();
    const tree = new BoardsTreeProvider(
      connection,
      new OpenedBoards({ get: () => undefined, update: async () => {} }),
      () => 2
    );
    tree.addSearch('Dev', title, results('Dev', [1]));
    tree.addSearch('Dev', title, results('Dev', [1]));
    tree.addSearch('Dev', author, results('Dev', [1]));
    tree.addSearch('Dev', { kind: 'push', threshold: 5 }, results('Dev', [1]));

    const group = (await tree.getChildren())[2]!;
    const labels = (await tree.getChildren(group)).map((n) => String(tree.getTreeItem(n).label));
    expect(labels).toEqual(['Dev：推文數超過 5', 'Dev：作者 bob']);
  });

  it('removes a search, and forgets all of them when the connection changes', async () => {
    const { connection, tree, labels } = setup();
    const a = tree.addSearch('Dev', title, results('Dev', [1]));
    tree.addSearch('Dev', author, results('Dev', [1]));
    tree.removeSearch(a);
    expect(await labels((await tree.getChildren())[2]!)).toEqual(['Dev：作者 bob']);

    connection.setState('disconnected');
    connection.setState('ready');
    expect(await labels()).toEqual(['我的最愛', '已開啟的看板']);
  });

  it('shows an error node instead of failing when a search cannot be run again', async () => {
    const { connection, tree } = setup();
    tree.addSearch('Dev', title, results('Dev', [1]));
    tree.refresh(); // drops the loaded results, so opening the node searches again
    connection.read.failWith = new ConnectionClosedError();
    const [search] = await tree.getChildren((await tree.getChildren())[2]!);
    const [node] = await tree.getChildren(search);
    expect(node!.kind).toBe('message');
  });
});
