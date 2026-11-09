import * as vscode from 'vscode';
import { parseArticleAddress } from '../core/aid';
import type { ArticleRef, ArticleSummary, SearchQuery } from '../core/models';
import { MAX_PUSH_THRESHOLD, MAX_TITLE_LENGTH, threadQuery, toSearchInput } from '../core/search';
import { isValidBoardName } from '../core/service';
import {
  ARTICLE_SCHEME,
  type ArticleContentProvider,
  articleUri,
  refFromUri,
} from './articleProvider';
import type { BoardsTreeProvider, TreeNode } from './boardsTree';
import type { ConnectionManager, LoginUi } from './connection';
import type { CredentialStore } from './credentialStore';
import type { HostKeyStore } from './hostKeys';
import { describeError } from './errorMessages';
import type { OpenedBoards } from './openedBoards';

export interface CommandDeps {
  connection: ConnectionManager;
  tree: BoardsTreeProvider;
  articles: ArticleContentProvider;
  opened: OpenedBoards;
  store: CredentialStore;
  ui: LoginUi;
  hostKeys: Pick<HostKeyStore, 'known' | 'forget'>;
}

const CLEAR = '清除';
const FORGET = '忘記';

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

/** Asks for a board name. Undefined when the user backs out. */
async function askBoard(title: string, prompt: string): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    title,
    prompt,
    placeHolder: '例如 Soft_Job',
    validateInput: (v) =>
      isValidBoardName(v.trim()) ? undefined : '看板名稱只能用英文字母、數字、底線、句點和連字號',
  });
  return input?.trim() || undefined;
}

/** The article tab a command was started from: its address, or the active editor's. */
function articleTab(arg: unknown): vscode.Uri | undefined {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === ARTICLE_SCHEME ? uri : undefined;
}

/** Shows `uri` with the cursor on `line`, in the middle of the editor. */
async function revealLine(uri: vscode.Uri, line: number): Promise<void> {
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  editor.selection = new vscode.Selection(line, 0, line, 0);
  editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
}

const JUMP = '跳到新推文';

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
  const { connection, tree, articles, opened, store, ui, hostKeys } = deps;
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

    register('vscptt.forgetHostKey', async () => {
      const known = hostKeys.known;
      if (!known) {
        ui.showInfo('還沒有記住任何 SSH 主機金鑰。');
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `要忘記已記住的 PTT SSH 主機金鑰（${known}）嗎？下次以 SSH 連線時會信任並記住當時的金鑰。`,
        { modal: true },
        FORGET
      );
      if (answer === FORGET) {
        await hostKeys.forget();
        ui.showInfo('已忘記 SSH 主機金鑰。');
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
      const name = await askBoard('開啟看板', '輸入看板名稱');
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
        board = await askBoard('搜尋看板', '要搜尋哪個看板？輸入看板名稱');
      }
      if (!board) {
        return;
      }
      const query = await askQuery();
      if (query) {
        await runSearch(board, query);
      }
    }),

    register('vscptt.searchSameTitle', async (arg?: unknown) => {
      const node = arg as Partial<TreeNode> | undefined;
      const summary = toSummary(node?.kind === 'article' ? node.summary : arg);
      const tab = summary ? undefined : articleTab(arg);
      const ref = tab && refFromUri(tab);
      const board = summary?.board ?? ref?.board;
      const title = summary?.title ?? (tab && articles.shownAt(tab)?.article.title) ?? ref?.title;
      const query = title === undefined ? undefined : threadQuery(title);
      if (!board || !isValidBoardName(board) || !query) {
        ui.showInfo('這篇文章的標題沒有可以搜尋的字。');
        return;
      }
      await runSearch(board, query);
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
      await guarded(() => busy('正在開啟文章…', () => showArticle(toRef(summary), summary.title)));
    }),

    register('vscptt.openArticleByAddress', async () => {
      const input = await vscode.window.showInputBox({
        title: '以文章代碼或網址開啟',
        prompt: '貼上文章網址，或文章代碼（例如 #1gvg4mau (Soft_Job)）',
        validateInput: (v) =>
          parseArticleAddress(v) ? undefined : '請輸入 PTT 文章網址，或 8 碼的文章代碼',
      });
      const address = input === undefined ? undefined : parseArticleAddress(input);
      if (!address) {
        return;
      }
      const board = address.board ?? (await askBoard('文章在哪個看板？', '輸入看板名稱'));
      if (!board || !(await ensureLoggedIn())) {
        return;
      }
      await guarded(() =>
        busy('正在尋找文章…', async () => {
          const summary = await connection.service.findArticle(board, address.id);
          await showArticle({ ...toRef(summary), id: address.id }, summary.title);
        })
      );
    }),

    register('vscptt.filterPushes', async (arg?: unknown) => {
      const tab = articleTab(arg);
      const shown = tab && articles.shownAt(tab);
      if (!tab || !shown || shown.article.pushes.length === 0) {
        ui.showInfo('這篇文章沒有推文。');
        return;
      }
      const { article, firstPushLine } = shown;
      const op = article.author.split(/\s/)[0];
      const counts = new Map<string, number>();
      for (const p of article.pushes) {
        counts.set(p.userId, (counts.get(p.userId) ?? 0) + 1);
      }
      const users = [...counts].sort(
        ([a, x], [b, y]) => Number(b === op) - Number(a === op) || y - x
      );
      const who = await vscode.window.showQuickPick(
        users.map(([user, n]) => ({
          label: user,
          description: `${n} 則${user === op ? '・原 PO' : ''}`,
        })),
        { placeHolder: '只看誰的推文？' }
      );
      if (!who) {
        return;
      }
      const items = article.pushes.flatMap((p, i) =>
        p.userId === who.label
          ? [
              {
                label: `${p.kind} ${p.content}`,
                description: p.time ? `${p.date} ${p.time}` : p.date,
                line: firstPushLine + i,
              },
            ]
          : []
      );
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `${who.label} 的 ${items.length} 則推文，選一則跳過去`,
      });
      if (pick) {
        await revealLine(tab, pick.line);
      }
    }),

    register('vscptt.refreshArticle', (uri?: unknown) => {
      const target = articleTab(uri);
      if (target) {
        articles.refresh(target);
      }
    }),

    register('vscptt.copyArticleId', (arg?: unknown) => copyFromArticle(arg, 'aid')),
    register('vscptt.copyArticleUrl', (arg?: unknown) => copyFromArticle(arg, 'url')),
    register('vscptt.openArticleInBrowser', (arg?: unknown) => copyFromArticle(arg, 'open')),

    // Not commands, but they belong with them: say when a re-read tab has new pushes, and forget closed tabs.
    articles.onDidFindNewPushes(async ({ uri, added, line }) => {
      if ((await vscode.window.showInformationMessage(`有 ${added} 則新推文。`, JUMP)) === JUMP) {
        await guarded(() => revealLine(uri, line));
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => articles.forget(doc.uri)),
  ];

  async function showArticle(ref: ArticleRef, title: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(articleUri(ref, title));
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async function runSearch(board: string, query: SearchQuery): Promise<void> {
    if (!(await ensureLoggedIn())) {
      return;
    }
    await guarded(async () => {
      const page = await busy(`正在搜尋 ${board}…`, () =>
        connection.service.searchBoard(board, query)
      );
      if (page.articles.length === 0) {
        ui.showInfo('沒有符合的文章。');
        return;
      }
      tree.addSearch(page.board, query, page);
    });
  }

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
