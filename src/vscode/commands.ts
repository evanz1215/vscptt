import * as vscode from 'vscode';
import type { ArticleRef, ArticleSummary, SearchQuery } from '../core/models';
import { MAX_PUSH_THRESHOLD, MAX_TITLE_LENGTH, toSearchInput } from '../core/search';
import { isValidBoardName } from '../core/service';
import { ARTICLE_SCHEME, type ArticleContentProvider, articleUri } from './articleProvider';
import type { BoardsTreeProvider, TreeNode } from './boardsTree';
import type { ConnectionManager, LoginUi } from './connection';
import type { CredentialStore } from './credentialStore';
import { describeError } from './errorMessages';
import type { OpenedBoards } from './openedBoards';

export interface CommandDeps {
  connection: ConnectionManager;
  tree: BoardsTreeProvider;
  articles: ArticleContentProvider;
  opened: OpenedBoards;
  store: CredentialStore;
  ui: LoginUi;
}

const CLEAR = '清除';

/** The article a tree node or menu stands for, if the argument really is one. */
function toSummary(arg: unknown): ArticleSummary | undefined {
  if (typeof arg !== 'object' || arg === null) {
    return undefined;
  }
  const s = arg as Partial<ArticleSummary>;
  return typeof s.board === 'string' &&
    typeof s.title === 'string' &&
    typeof s.isPinned === 'boolean'
    ? (s as ArticleSummary)
    : undefined;
}

function toRef(summary: ArticleSummary): ArticleRef {
  return summary.isPinned
    ? {
        board: summary.board,
        isPinned: true,
        pinnedIndex: summary.pinnedIndex,
        title: summary.title,
        author: summary.author,
      }
    : {
        board: summary.board,
        listNumber: summary.listNumber,
        title: summary.title,
        author: summary.author,
        ...(summary.search ? { search: summary.search } : {}),
      };
}

/** Asks what to search for. Undefined when the user backs out at any step. */
async function askQuery(): Promise<SearchQuery | undefined> {
  const kinds = [
    { label: '標題關鍵字', kind: 'title' as const },
    { label: '作者', kind: 'author' as const },
    { label: '推文數（負數＝噓文數）', kind: 'push' as const },
  ];
  const pick = await vscode.window.showQuickPick(
    kinds.map((k) => k.label),
    { placeHolder: '要搜尋什麼？' }
  );
  const kind = kinds.find((k) => k.label === pick)?.kind;
  if (!kind) {
    return undefined;
  }
  const check = (query: SearchQuery): string | undefined => {
    try {
      toSearchInput(query);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  if (kind === 'push') {
    const input = await vscode.window.showInputBox({
      title: '搜尋推文數',
      prompt: `推文數高於多少的文章？輸入負數則搜噓文數（-${MAX_PUSH_THRESHOLD} 到 ${MAX_PUSH_THRESHOLD}）`,
      placeHolder: '例如 30',
      validateInput: (v) =>
        /^-?\d{1,3}$/.test(v.trim())
          ? check({ kind: 'push', threshold: Number(v.trim()) })
          : '請輸入整數',
    });
    return input === undefined ? undefined : { kind: 'push', threshold: Number(input.trim()) };
  }
  const input = await vscode.window.showInputBox({
    title: kind === 'title' ? '搜尋標題' : '搜尋作者',
    prompt:
      kind === 'title'
        ? `標題包含的字（最多 ${MAX_TITLE_LENGTH} 字）`
        : '作者的帳號（英文字母、數字、底線，最多 12 字）',
    validateInput: (v) => check({ kind, text: v }),
  });
  return input === undefined ? undefined : { kind, text: kind === 'title' ? input.trim() : input };
}

/** The one address shape an article page has; nothing else is ever opened in the browser. */
const ARTICLE_URL =
  /^https:\/\/www\.ptt\.cc\/bbs\/[A-Za-z0-9_-]+\/M\.\d+\.A\.[0-9A-Fa-f]{3}\.html$/;
export const isPttArticleUrl = (url: string): boolean => ARTICLE_URL.test(url);

/** Registers every command declared in package.json. */
export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { connection, tree, articles, opened, store, ui } = deps;
  const register = (id: string, handler: (...args: unknown[]) => unknown) =>
    vscode.commands.registerCommand(id, handler);

  const busy = <T>(title: string, task: () => Promise<T>): Thenable<T> =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

  /** Logs in first if needed. False when the user did not end up logged in. */
  const ensureLoggedIn = async (): Promise<boolean> =>
    connection.state === 'ready' || (await connection.login());

  /** Runs `task`, showing a friendly message instead of letting an error escape. */
  const guarded = async (task: () => PromiseLike<void>): Promise<void> => {
    try {
      await task();
    } catch (error) {
      ui.showError(describeError(error));
    }
  };

  return [
    register('vscptt.login', async () => {
      await connection.login();
    }),

    register('vscptt.logout', async () => {
      await connection.logout();
      ui.showInfo('已登出。');
    }),

    register('vscptt.reconnect', async () => {
      await connection.reconnect();
    }),

    register('vscptt.clearCredentials', async () => {
      const answer = await vscode.window.showWarningMessage(
        '要清除已儲存的 PTT 帳號和密碼嗎？',
        { modal: true },
        CLEAR
      );
      if (answer === CLEAR) {
        await store.clear();
        ui.showInfo('已清除儲存的帳號和密碼。');
      }
    }),

    register('vscptt.statusMenu', async () => {
      if (connection.state === 'connecting') {
        ui.showInfo('正在連線中…');
        return;
      }
      const items =
        connection.state === 'ready'
          ? ['登出', '重新連線', '清除已儲存的帳密']
          : ['登入', '清除已儲存的帳密'];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'PTT 連線選項' });
      const command: Record<string, string> = {
        登出: 'vscptt.logout',
        重新連線: 'vscptt.reconnect',
        登入: 'vscptt.login',
        清除已儲存的帳密: 'vscptt.clearCredentials',
      };
      if (pick && command[pick]) {
        await vscode.commands.executeCommand(command[pick]!);
      }
    }),

    register('vscptt.refresh', (node?: unknown) => {
      const target = node as TreeNode | undefined;
      tree.refresh(target?.kind === 'board' ? target.board : undefined);
    }),

    register('vscptt.clearCache', () => {
      tree.refresh();
      ui.showInfo('已清除快取。');
    }),

    register('vscptt.openBoard', async () => {
      const input = await vscode.window.showInputBox({
        title: '開啟看板',
        prompt: '輸入看板名稱',
        placeHolder: '例如 Soft_Job',
        validateInput: (v) =>
          isValidBoardName(v.trim())
            ? undefined
            : '看板名稱只能用英文字母、數字、底線、句點和連字號',
      });
      const name = input?.trim();
      if (!name || !(await ensureLoggedIn())) {
        return;
      }
      await guarded(async () => {
        const found = await busy(`正在開啟看板 ${name}…`, () => connection.service.openBoard(name));
        if (!found) {
          ui.showError(`找不到看板「${name}」，或沒有權限進入。`);
          return;
        }
        await opened.add(name);
        tree.refresh();
        ui.showInfo(`已加入「已開啟的看板」：${name}`);
      });
    }),

    register('vscptt.loadMore', async (board?: unknown, searchId?: unknown) => {
      if (typeof board !== 'string' || !isValidBoardName(board)) {
        return;
      }
      const load =
        typeof searchId === 'number'
          ? () => tree.loadMoreSearch(searchId)
          : () => tree.loadMore(board);
      await guarded(() => busy('正在載入較舊的文章…', load));
    }),

    register('vscptt.search', async (arg?: unknown) => {
      const node = arg as Partial<TreeNode> | undefined;
      let board =
        node?.kind === 'board' || node?.kind === 'search'
          ? node.board
          : node?.kind === 'article'
            ? node.summary?.board
            : undefined;
      if (typeof board !== 'string' || !isValidBoardName(board)) {
        const input = await vscode.window.showInputBox({
          title: '搜尋看板',
          prompt: '要搜尋哪個看板？輸入看板名稱',
          placeHolder: '例如 Soft_Job',
          validateInput: (v) =>
            isValidBoardName(v.trim())
              ? undefined
              : '看板名稱只能用英文字母、數字、底線、句點和連字號',
        });
        board = input?.trim();
      }
      if (!board) {
        return;
      }
      const query = await askQuery();
      if (!query || !(await ensureLoggedIn())) {
        return;
      }
      const name = board;
      await guarded(async () => {
        const page = await busy(`正在搜尋 ${name}…`, () =>
          connection.service.searchBoard(name, query)
        );
        if (page.articles.length === 0) {
          ui.showInfo('沒有符合的文章。');
          return;
        }
        tree.addSearch(page.board, query, page);
      });
    }),

    register('vscptt.removeSearch', (node?: unknown) => {
      const target = node as Partial<TreeNode> | undefined;
      if (target?.kind === 'search' && typeof target.id === 'number') {
        tree.removeSearch(target.id);
      }
    }),

    register('vscptt.openArticle', async (arg?: unknown) => {
      const summary = toSummary(arg);
      if (!summary) {
        return;
      }
      if (summary.kind === 'deleted') {
        ui.showInfo('這篇文章已被刪除，沒有內容可以看。'); // no request is made for it
        return;
      }
      if (!(await ensureLoggedIn())) {
        return;
      }
      await guarded(() =>
        busy('正在開啟文章…', async () => {
          const doc = await vscode.workspace.openTextDocument(
            articleUri(toRef(summary), summary.title)
          );
          await vscode.window.showTextDocument(doc, { preview: true });
        })
      );
    }),

    register('vscptt.refreshArticle', (uri?: unknown) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme === ARTICLE_SCHEME) {
        articles.refresh(target);
      }
    }),

    register('vscptt.copyArticleId', (arg?: unknown) => copyFromArticle(arg, 'aid')),
    register('vscptt.copyArticleUrl', (arg?: unknown) => copyFromArticle(arg, 'url')),
    register('vscptt.openArticleInBrowser', (arg?: unknown) => copyFromArticle(arg, 'open')),
  ];

  async function copyFromArticle(arg: unknown, what: 'aid' | 'url' | 'open'): Promise<void> {
    const node = arg as Partial<TreeNode> | undefined;
    const summary = toSummary(node?.kind === 'article' ? node.summary : arg);
    if (!summary || !(await ensureLoggedIn())) {
      return;
    }
    await guarded(async () => {
      const resolved = await busy('正在取得文章代碼…', () =>
        connection.service.resolveArticleId(toRef(summary))
      );
      if (what === 'open') {
        // The address was read off the screen, so only the exact shape of an article page is handed to the browser.
        if (!isPttArticleUrl(resolved.url)) {
          ui.showError('取得的文章網址格式不正確，已取消開啟。');
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(resolved.url));
        return;
      }
      const value = what === 'aid' ? resolved.aid : resolved.url;
      await vscode.env.clipboard.writeText(value);
      ui.showInfo(`已複製${what === 'aid' ? '文章代碼' : '文章網址'}：${value}`);
    });
  }
}
