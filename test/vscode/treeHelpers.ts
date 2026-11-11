import * as vscode from 'vscode';
import { ConnectionClosedError } from '../../src/core/errors';
import type {
  ArticleSummary,
  BoardPage,
  FavoriteEntry,
  PageCursor,
  SearchQuery,
} from '../../src/core/models';
import type { ConnectionState } from '../../src/vscode/connection';
import type { ReadService, TreeConnection } from '../../src/vscode/boardsTree';

export function summary(n: number, extra: Partial<ArticleSummary> = {}): ArticleSummary {
  return {
    board: 'Dev',
    listNumber: n,
    isPinned: false,
    title: `[測試] 第${n}篇`,
    author: `user${n % 5}`,
    date: '11/01',
    push: n % 3 === 0 ? '' : String(n),
    mark: '',
    kind: 'normal',
    ...extra,
  };
}

export function pinnedSummary(index: number, extra: Partial<ArticleSummary> = {}): ArticleSummary {
  return {
    board: 'Dev',
    listNumber: undefined,
    pinnedIndex: index,
    isPinned: true,
    title: `[公告] 置頂${index}`,
    author: 'mod',
    date: '8/04',
    push: '',
    mark: 'm',
    kind: 'normal',
    ...extra,
  };
}

/** Newest first. `hasOlder` pages carry a cursor to the next one, like the real service. */
export function page(
  board: string,
  numbers: number[],
  options: { pinned?: number; hasOlder?: boolean } = {}
): BoardPage {
  const oldest = numbers.at(-1);
  return {
    board,
    articles: numbers.map((n) => summary(n, { board })),
    pinned: Array.from({ length: options.pinned ?? 0 }, (_, i) => pinnedSummary(i, { board })),
    hasOlder: options.hasOlder ?? false,
    next: options.hasOlder && oldest !== undefined ? { before: oldest } : undefined,
  };
}

/** A ReadService whose answers are set by the test. Records every call. */
export class FakeReadService implements ReadService {
  favorites: FavoriteEntry[] = [];
  pages = new Map<string, BoardPage[]>(); // by lower-case board; index 0 is the latest page
  calls: string[] = [];
  failWith: unknown;
  delayMs = 0;

  async getFavorites(): Promise<FavoriteEntry[]> {
    this.calls.push('getFavorites');
    await this.pause();
    return this.favorites;
  }

  hot: FavoriteEntry[] = [];

  async getHotBoards(): Promise<FavoriteEntry[]> {
    this.calls.push('getHotBoards');
    await this.pause();
    return this.hot;
  }

  async getBoardPage(board: string, cursor?: PageCursor): Promise<BoardPage> {
    this.calls.push(`getBoardPage:${board}:${cursor ? cursor.before : 'latest'}`);
    await this.pause();
    const list = this.pages.get(board.toLowerCase()) ?? [];
    const found = cursor
      ? list.find((p) => p.articles[0]?.listNumber === cursor.before - 1)
      : list[0];
    if (!found) {
      throw new Error(`no page for ${board} ${cursor?.before ?? 'latest'}`);
    }
    return found;
  }

  /** Search results by "board:query"; index 0 is the first page. */
  searchPages = new Map<string, BoardPage[]>();

  async searchBoard(board: string, query: SearchQuery, cursor?: PageCursor): Promise<BoardPage> {
    this.calls.push(
      `searchBoard:${board}:${JSON.stringify(query)}:${cursor ? cursor.before : 'latest'}`
    );
    await this.pause();
    const list = this.searchPages.get(`${board.toLowerCase()}:${JSON.stringify(query)}`) ?? [];
    const found = cursor
      ? list.find((p) => p.articles[0]?.listNumber === cursor.before - 1)
      : list[0];
    if (!found) {
      throw new Error('no search page');
    }
    return found;
  }

  invalidate(board?: string): void {
    this.calls.push(`invalidate:${board ?? '*'}`);
  }

  private async pause(): Promise<void> {
    if (this.failWith) {
      throw this.failWith;
    }
    if (this.delayMs) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
  }
}

export class FakeTreeConnection implements TreeConnection {
  private readonly emitter = new vscode.EventEmitter<ConnectionState>();
  readonly onDidChangeState = this.emitter.event;
  state: ConnectionState = 'ready';
  readonly read = new FakeReadService();

  get service(): ReadService {
    if (this.state !== 'ready') {
      throw new ConnectionClosedError();
    }
    return this.read;
  }

  setState(state: ConnectionState): void {
    this.state = state;
    this.emitter.fire(state);
  }
}
