import * as vscode from 'vscode';
import { ConnectionClosedError, NotLoggedInError } from '../core/errors';
import type {
  ArticleSummary,
  BoardPage,
  FavoriteEntry,
  PageCursor,
  SearchQuery,
} from '../core/models';
import { describeSearch } from '../core/search';
import type { ConnectionState } from './connection';
import { describeError } from './errorMessages';
import type { OpenedBoards } from './openedBoards';

export type Group = 'favorites' | 'opened' | 'search';

export type TreeNode =
  | { kind: 'login'; connecting: boolean }
  | { kind: 'group'; group: Group }
  | {
      kind: 'board';
      group: Group;
      board: string;
      category?: string;
      title?: string;
      /** The favorites folder it was listed in; the same board can be listed in several places. */
      place?: string;
    }
  | { kind: 'folder'; path: string; title: string; entries?: FavoriteEntry[] }
  | { kind: 'pinned'; group: Group; board: string; count: number }
  | { kind: 'search'; id: number; board: string; query: SearchQuery }
  | { kind: 'article'; group: Group; summary: ArticleSummary; searchId?: number }
  | { kind: 'loadMore'; group: Group; board: string; searchId?: number }
  | { kind: 'message'; text: string; command?: string; icon?: string };

/** What the tree reads PTT through. PttService satisfies it. */
export interface ReadService {
  getFavorites(): Promise<FavoriteEntry[]>;
  getBoardPage(board: string, cursor?: PageCursor): Promise<BoardPage>;
  searchBoard(board: string, query: SearchQuery, cursor?: PageCursor): Promise<BoardPage>;
  invalidate(board?: string): void;
}

/** What the tree needs from the connection. ConnectionManager satisfies it. */
export interface TreeConnection {
  readonly state: ConnectionState;
  /** Throws when there is no usable connection. */
  readonly service: ReadService;
  readonly onDidChangeState: vscode.Event<ConnectionState>;
}

const icon = (id: string) => new vscode.ThemeIcon(id);

/** Tree nodes for a favorites list: its boards, and its folders (which open into the same kind of list). */
function favoriteItems(entries: FavoriteEntry[], parent: string): TreeNode[] {
  return entries.map((f, i): TreeNode => {
    if (f.kind === 'folder') {
      return { kind: 'folder', path: `${parent}/${i}`, title: f.title, entries: f.entries };
    }
    return {
      kind: 'board',
      group: 'favorites',
      board: f.name,
      category: f.category,
      title: f.title,
      place: parent,
    };
  });
}

function errorNode(error: unknown): TreeNode {
  const lost = error instanceof ConnectionClosedError || error instanceof NotLoggedInError;
  return {
    kind: 'message',
    text: describeError(error),
    command: lost ? 'vscptt.reconnect' : 'vscptt.refresh',
    icon: 'warning',
  };
}

/** The "PTT" tree: favorites and opened boards, with their articles. Never throws from getChildren. */
export class BoardsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** Pages loaded per board (lower-case name), newest page first. Shared by both groups. */
  private readonly pages = new Map<string, BoardPage[]>();
  private readonly loading = new Map<string, Promise<BoardPage[]>>();
  /** Searches the user ran this session, newest first, with the pages each has loaded. Lost on logout. */
  private searches: Array<{ id: number; board: string; query: SearchQuery }> = [];
  private readonly searchPages = new Map<number, BoardPage[]>();
  private nextSearchId = 1;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly connection: TreeConnection,
    private readonly opened: OpenedBoards,
    private readonly maxSearches: () => number = () => 10
  ) {
    this.subscription = connection.onDidChangeState(() => {
      this.pages.clear(); // a new connection means anything loaded before may be stale
      this.searches = [];
      this.searchPages.clear();
      this.emitter.fire(undefined);
    });
  }

  /** Forget what was loaded (for one board, or all) and redraw. The service's own cache is dropped too. */
  refresh(board?: string): void {
    try {
      if (board) {
        this.pages.delete(board.toLowerCase());
        this.connection.service.invalidate(board);
      } else {
        this.pages.clear();
        this.searchPages.clear(); // the searches stay listed and run again when opened
        this.connection.service.invalidate();
      }
    } catch {
      // not connected: nothing cached on the service side
    }
    this.emitter.fire(undefined);
  }

  /** Appends the next older page of a board to what is shown. Errors are left to the caller. */
  async loadMore(board: string): Promise<void> {
    const key = board.toLowerCase();
    const loaded = this.pages.get(key);
    const last = loaded?.at(-1);
    if (!loaded || !last?.hasOlder || !last.next) {
      return;
    }
    const next = await this.connection.service.getBoardPage(board, last.next);
    if (this.pages.get(key)?.at(-1) !== last) {
      return; // the board was refreshed or another load got there first
    }
    loaded.push(next);
    this.emitter.fire(undefined);
  }

  /**
   * Adds a search to the "搜尋結果" group (a repeat of the same search replaces the old entry) and returns its
   * id. `first` is the page already fetched for it.
   */
  addSearch(board: string, query: SearchQuery, first: BoardPage): number {
    const same = JSON.stringify(query);
    for (const old of this.searches.filter(
      (s) => s.board.toLowerCase() === board.toLowerCase() && JSON.stringify(s.query) === same
    )) {
      this.searchPages.delete(old.id);
    }
    this.searches = this.searches.filter(
      (s) => s.board.toLowerCase() !== board.toLowerCase() || JSON.stringify(s.query) !== same
    );
    const id = this.nextSearchId++;
    this.searches.unshift({ id, board, query });
    for (const dropped of this.searches.splice(Math.max(this.maxSearches(), 1))) {
      this.searchPages.delete(dropped.id);
    }
    this.searchPages.set(id, [first]);
    this.emitter.fire(undefined);
    return id;
  }

  removeSearch(id: number): void {
    this.searches = this.searches.filter((s) => s.id !== id);
    this.searchPages.delete(id);
    this.emitter.fire(undefined);
  }

  /** Appends the next older page of a search's results. Errors are left to the caller. */
  async loadMoreSearch(id: number): Promise<void> {
    const entry = this.searches.find((s) => s.id === id);
    const loaded = this.searchPages.get(id);
    const last = loaded?.at(-1);
    if (!entry || !loaded || !last?.hasOlder || !last.next) {
      return;
    }
    const next = await this.connection.service.searchBoard(entry.board, entry.query, last.next);
    if (this.searchPages.get(id)?.at(-1) !== last) {
      return;
    }
    loaded.push(next);
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  // ---- TreeDataProvider ----

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      return this.rootNodes();
    }
    switch (node.kind) {
      case 'group':
        return node.group === 'favorites'
          ? this.favoriteNodes()
          : node.group === 'opened'
            ? this.openedNodes()
            : this.searches.map((s) => ({ kind: 'search' as const, ...s }));
      case 'search':
        return this.searchChildren(node.id);
      case 'folder':
        return favoriteItems(node.entries ?? [], node.path);
      case 'board':
        return this.boardChildren(node.group, node.board);
      case 'pinned':
        return this.pinnedChildren(node.group, node.board);
      default:
        return [];
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'login': {
        const item = new vscode.TreeItem(node.connecting ? '連線中…' : '登入 PTT…');
        item.id = 'login';
        item.iconPath = icon(node.connecting ? 'sync~spin' : 'sign-in');
        item.contextValue = 'login';
        if (!node.connecting) {
          item.command = { command: 'vscptt.login', title: '登入 PTT' };
        }
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(
          node.group === 'favorites'
            ? '我的最愛'
            : node.group === 'opened'
              ? '已開啟的看板'
              : '搜尋結果',
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.id = `group:${node.group}`;
        item.iconPath = icon(
          node.group === 'favorites'
            ? 'star-full'
            : node.group === 'opened'
              ? 'folder-opened'
              : 'search'
        );
        item.contextValue = 'group';
        return item;
      }
      case 'board': {
        const item = new vscode.TreeItem(node.board, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `board:${node.group}:${node.place ?? ''}:${node.board.toLowerCase()}`;
        item.description = node.category;
        item.tooltip = node.title ?? node.board;
        item.iconPath = icon('comment-discussion');
        item.contextValue = 'board';
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(
          node.title || '資料夾',
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `folder:${node.path}`;
        item.description = node.entries ? undefined : '無法讀取';
        item.iconPath = icon('folder');
        item.contextValue = 'favoriteFolder';
        return item;
      }
      case 'search': {
        const item = new vscode.TreeItem(
          `${node.board}：${describeSearch(node.query)}`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.id = `search:${node.id}`;
        item.iconPath = icon('search');
        item.contextValue = 'search';
        return item;
      }
      case 'pinned': {
        const item = new vscode.TreeItem(
          `置頂文（${node.count}）`,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `pinned:${node.group}:${node.board.toLowerCase()}`;
        item.iconPath = icon('pin');
        item.contextValue = 'pinnedGroup';
        return item;
      }
      case 'article':
        return this.articleItem(node);
      case 'loadMore': {
        const item = new vscode.TreeItem('載入更多（較舊的文章）…');
        item.id = `more:${node.group}:${node.searchId ?? ''}:${node.board.toLowerCase()}`;
        item.iconPath = icon('chevron-down');
        item.contextValue = 'loadMore';
        item.command = {
          command: 'vscptt.loadMore',
          title: '載入更多',
          arguments: node.searchId === undefined ? [node.board] : [node.board, node.searchId],
        };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = icon(node.icon ?? 'info');
        item.contextValue = 'message';
        if (node.command) {
          item.command = { command: node.command, title: node.text };
        }
        return item;
      }
    }
  }

  // ---- building nodes ----

  private rootNodes(): TreeNode[] {
    switch (this.connection.state) {
      case 'ready':
        return [
          { kind: 'group', group: 'favorites' },
          { kind: 'group', group: 'opened' },
          ...(this.searches.length > 0
            ? [{ kind: 'group' as const, group: 'search' as const }]
            : []),
        ];
      case 'connecting':
        return [{ kind: 'login', connecting: true }];
      case 'disconnected':
        return [{ kind: 'login', connecting: false }];
    }
  }

  private async favoriteNodes(): Promise<TreeNode[]> {
    try {
      const favorites = await this.connection.service.getFavorites();
      if (favorites.length === 0) {
        return [{ kind: 'message', text: '最愛清單是空的', icon: 'info' }];
      }
      return favoriteItems(favorites, '');
    } catch (error) {
      return [errorNode(error)];
    }
  }

  private openedNodes(): TreeNode[] {
    const names = this.opened.list();
    if (names.length === 0) {
      return [
        {
          kind: 'message',
          text: '尚未開啟任何看板：點這裡輸入看板名稱',
          command: 'vscptt.openBoard',
          icon: 'add',
        },
      ];
    }
    return names.map((board) => ({ kind: 'board' as const, group: 'opened' as const, board }));
  }

  private async boardChildren(group: Group, board: string): Promise<TreeNode[]> {
    try {
      const pages = await this.firstPage(board);
      const nodes: TreeNode[] = [];
      const pinned = pages[0]!.pinned;
      if (pinned.length > 0) {
        nodes.push({ kind: 'pinned', group, board, count: pinned.length });
      }
      const seen = new Set<number>();
      for (const page of pages) {
        for (const summary of page.articles) {
          if (summary.listNumber === undefined || !seen.has(summary.listNumber)) {
            if (summary.listNumber !== undefined) {
              seen.add(summary.listNumber);
            }
            nodes.push({ kind: 'article', group, summary });
          }
        }
      }
      const last = pages.at(-1)!;
      if (last.hasOlder && last.next) {
        nodes.push({ kind: 'loadMore', group, board });
      }
      return nodes.length > 0
        ? nodes
        : [{ kind: 'message', text: '這個看板沒有文章', icon: 'info' }];
    } catch (error) {
      return [errorNode(error)];
    }
  }

  private async searchChildren(id: number): Promise<TreeNode[]> {
    const entry = this.searches.find((s) => s.id === id);
    if (!entry) {
      return [];
    }
    try {
      let pages = this.searchPages.get(id);
      if (!pages) {
        pages = [await this.connection.service.searchBoard(entry.board, entry.query)];
        if (this.searches.some((s) => s.id === id)) {
          this.searchPages.set(id, pages); // not if it was removed while the search ran
        }
      }
      const nodes: TreeNode[] = [];
      for (const page of pages) {
        for (const summary of page.articles) {
          nodes.push({ kind: 'article', group: 'search', summary, searchId: id });
        }
      }
      const last = pages.at(-1)!;
      if (last.hasOlder && last.next) {
        nodes.push({ kind: 'loadMore', group: 'search', board: entry.board, searchId: id });
      }
      return nodes.length > 0 ? nodes : [{ kind: 'message', text: '沒有符合的文章', icon: 'info' }];
    } catch (error) {
      return [errorNode(error)];
    }
  }

  private async pinnedChildren(group: Group, board: string): Promise<TreeNode[]> {
    try {
      const pages = await this.firstPage(board);
      return pages[0]!.pinned.map((summary) => ({ kind: 'article' as const, group, summary }));
    } catch (error) {
      return [errorNode(error)];
    }
  }

  /** The loaded pages of a board, fetching the latest page first if needed. Concurrent calls share one fetch. */
  private firstPage(board: string): Promise<BoardPage[]> {
    const key = board.toLowerCase();
    const have = this.pages.get(key);
    if (have) {
      return Promise.resolve(have);
    }
    let pending = this.loading.get(key);
    if (!pending) {
      pending = (async () => {
        const page = await this.connection.service.getBoardPage(board);
        const pages = [page];
        this.pages.set(key, pages);
        return pages;
      })().finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return pending;
  }

  private articleItem(node: Extract<TreeNode, { kind: 'article' }>): vscode.TreeItem {
    const { summary } = node;
    const item = new vscode.TreeItem(summary.title);
    const where = summary.isPinned ? `p${summary.pinnedIndex}` : String(summary.listNumber);
    const searchPart = node.searchId === undefined ? '' : `:${node.searchId}`;
    item.id = `article:${node.group}${searchPart}:${summary.board.toLowerCase()}:${where}`;
    item.description = [summary.push ? `[${summary.push}]` : '', summary.author, summary.date]
      .filter(Boolean)
      .join(' ');

    const lines = [summary.title, `作者：${summary.author}`, `日期：${summary.date}`];
    if (summary.push) {
      lines.push(`推文：${summary.push}`);
    }
    if (summary.isPinned) {
      lines.push('置頂文：內容可能與列表上的標題不同');
    }
    if (summary.kind === 'deleted') {
      lines.push('這篇文章已被刪除');
    }
    item.tooltip = lines.join('\n');

    item.iconPath = icon(
      summary.kind === 'deleted'
        ? 'trash'
        : summary.isPinned
          ? 'pin'
          : summary.kind === 'reply'
            ? 'comment'
            : 'file-text'
    );
    item.contextValue = `article${summary.isPinned ? '.pinned' : ''}${summary.kind === 'deleted' ? '.deleted' : ''}`;
    item.command = { command: 'vscptt.openArticle', title: '開啟文章', arguments: [summary] };
    return item;
  }
}
