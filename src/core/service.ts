import { aidFromId } from './aid';
import { TtlCache } from './cache/ttlCache';
import {
  ArticleDeletedError,
  ArticleMismatchError,
  ArticleNotFoundError,
  BoardNotFoundError,
  ConnectionClosedError,
  InvalidArgumentError,
  UnexpectedScreenError,
} from './errors';
import { Keys } from './keys';
import type {
  Article,
  ArticleId,
  ArticleRef,
  ArticleSummary,
  BoardPage,
  FavoriteEntry,
  PageCursor,
  ResolvedArticle,
  SearchQuery,
} from './models';
import { WaitTimeoutError } from './queue/waitFor';
import { normalizeSearch, toSearchInput } from './search';
import { type AidPopup, idFromUrl, parseAidPopup } from './screens/aidPopup';
import { type ParsedArticle, mergePages, parseArticle, parseArticlePage } from './screens/article';
import {
  type BoardListScreen,
  type ListMode,
  type ListRow,
  isBoardList,
  parseBoardList,
  sameBoard,
} from './screens/boardList';
import {
  type FavoriteRow,
  isFavoritesScreen,
  isHotBoardsScreen,
  parseFavorites,
  selectedNumber,
} from './screens/favorites';
import {
  isAidPrompt,
  isAnyKeyPrompt,
  isBoardSelectPrompt,
  isLogoutConfirm,
  isMainMenu,
  isNoSearchResult,
  isSearchPrompt,
} from './screens/prompts';
import type { Credentials, Session, SessionState } from './session/session';

export interface PttServiceOptions {
  cacheTtlSeconds?: {
    latestPage?: number;
    olderPage?: number;
    article?: number;
    favorites?: number;
  };
  /** Articles longer than this many screens are cut off and flagged `truncated`. */
  maxArticlePages?: number;
  /** How long to wait for a board to appear after typing its name before concluding it does not exist. */
  boardEnterTimeoutMs?: number;
  /** How long to wait for a further favorites page before concluding the list has ended. */
  nextPageTimeoutMs?: number;
  /** Clock for the caches; replace in tests. */
  now?: () => number;
}

const BOARD_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$/;
const FAVORITES_PAGE_LIMIT = 10;
/** Folders inside folders, and how many folders one reading may open: a bound on time and on being lost. */
const FAVORITES_DEPTH_LIMIT = 3;
const FAVORITES_FOLDER_LIMIT = 20;
const LIST_PAGE_SIZE = 20;
/** How often expired cache entries are dropped while the extension sits idle. */
export const CACHE_SWEEP_MS = 5 * 60_000;
const MAX_LIST_NUMBER = 9_999_999; // PTT shows at most 6 digits per number; stay clear of exponent notation

/**
 * Reads PTT through a logged-in Session. Every operation runs in the session queue, starts from a known
 * screen, waits for the screen it expects after each key, and goes back to the main menu if anything fails.
 */
export class PttService {
  private readonly pages: TtlCache<BoardPage>;
  private readonly articles: TtlCache<Article>;
  private readonly favorites: TtlCache<FavoriteEntry[]>;
  private readonly ttl: {
    latestPage: number;
    olderPage: number;
    article: number;
    favorites: number;
  };
  private readonly maxArticlePages: number;
  private readonly boardEnterTimeoutMs: number;
  private readonly nextPageTimeoutMs: number;

  constructor(
    readonly session: Session,
    options: PttServiceOptions = {}
  ) {
    const t = options.cacheTtlSeconds ?? {};
    this.ttl = {
      latestPage: (t.latestPage ?? 60) * 1000,
      olderPage: (t.olderPage ?? 600) * 1000,
      article: (t.article ?? 300) * 1000,
      favorites: (t.favorites ?? 300) * 1000,
    };
    this.maxArticlePages = options.maxArticlePages ?? 30;
    this.boardEnterTimeoutMs = options.boardEnterTimeoutMs ?? 5000;
    this.nextPageTimeoutMs = options.nextPageTimeoutMs ?? 1500;
    this.pages = new TtlCache(options.now);
    this.articles = new TtlCache(options.now);
    this.favorites = new TtlCache(options.now);
    // VS Code often stays open for days: drop expired results even while nothing new is read.
    const sweep = setInterval(() => {
      this.pages.prune();
      this.articles.prune();
      this.favorites.prune();
    }, CACHE_SWEEP_MS);
    sweep.unref?.();
    session.onStateChange((state) => {
      if (state === 'disconnected') {
        clearInterval(sweep);
        this.invalidate();
      }
    });
  }

  get state(): SessionState {
    return this.session.state;
  }

  onStateChange(listener: (state: SessionState) => void): () => void {
    return this.session.onStateChange(listener);
  }

  login(credentials: Credentials): Promise<void> {
    return this.session.login(credentials);
  }

  async logout(): Promise<void> {
    try {
      await this.session.logout();
    } finally {
      this.invalidate();
    }
  }

  async getFavorites(): Promise<FavoriteEntry[]> {
    this.session.assertReady();
    return structuredClone(
      await this.favorites.getOrLoad('favorites', this.ttl.favorites, () =>
        this.session.run(() => this.guard(() => this.loadFavorites()))
      )
    );
  }

  /** The hot boards (熱門看板), cached like the favorites. */
  async getHotBoards(): Promise<FavoriteEntry[]> {
    this.session.assertReady();
    return structuredClone(
      await this.favorites.getOrLoad('hot', this.ttl.favorites, () =>
        this.session.run(() => this.guard(() => this.loadHotBoards()))
      )
    );
  }

  /** True when the board exists and was entered. PTT completes names loosely, so the result is checked. */
  async openBoard(name: string): Promise<boolean> {
    assertBoardName(name);
    this.session.assertReady();
    return this.session.run(() =>
      this.guard(async () => {
        const list = await this.enterBoard(name);
        return list !== null;
      })
    );
  }

  /** The latest page when `cursor` is omitted; otherwise the 20 articles below `cursor.before`. */
  async getBoardPage(board: string, cursor?: PageCursor): Promise<BoardPage> {
    assertBoardName(board);
    this.session.assertReady();
    if (cursor && !isListNumber(cursor.before)) {
      throw new InvalidArgumentError(
        `cursor.before must be a whole number from 1 to ${MAX_LIST_NUMBER}`
      );
    }
    const key = `${board.toLowerCase()}:${cursor ? `before:${cursor.before}` : 'latest'}`;
    return structuredClone(
      await this.pages.getOrLoad(key, cursor ? this.ttl.olderPage : this.ttl.latestPage, () =>
        this.session.run(() => this.guard(() => this.loadPage(board, cursor)))
      )
    );
  }

  /**
   * Searches one board (title, author or push count). Same shape as getBoardPage: newest result first, older
   * ones through `cursor`; `listNumber` is the position among the results. The search is typed again for every
   * page, because the result screen does not say what was searched for.
   */
  async searchBoard(board: string, rawQuery: SearchQuery, cursor?: PageCursor): Promise<BoardPage> {
    assertBoardName(board);
    const query = normalizeSearch(rawQuery);
    this.session.assertReady();
    if (cursor && !isListNumber(cursor.before)) {
      throw new InvalidArgumentError(
        `cursor.before must be a whole number from 1 to ${MAX_LIST_NUMBER}`
      );
    }
    const where = cursor ? `before:${cursor.before}` : 'latest';
    const key = `${board.toLowerCase()}:search:${JSON.stringify(query)}:${where}`;
    return structuredClone(
      await this.pages.getOrLoad(key, cursor ? this.ttl.olderPage : this.ttl.latestPage, () =>
        this.session.run(() => this.guard(() => this.loadPage(board, cursor, query)))
      )
    );
  }

  /** Finds the stable id of a list entry (press `Q` on it). */
  async resolveArticleId(ref: ArticleRef): Promise<ResolvedArticle> {
    assertRef(ref);
    this.session.assertReady();
    return this.session.run(() =>
      this.guard(async () => {
        await this.position(ref);
        const popup = await this.readPopup(ref.board, listMode(ref));
        checkId(ref, popup.id);
        return { board: popup.board, id: popup.id, aid: popup.aid, url: popup.url };
      })
    );
  }

  /**
   * Finds an article of `board` by its id (`#` and its code) and returns it as a list entry for getArticle.
   * The `Q` box confirms the cursor really landed on it. Not yet seen on the live server: the prompt and the
   * not-found notice follow mbbsd's source.
   */
  async findArticle(board: string, id: ArticleId): Promise<ArticleSummary> {
    assertBoardName(board);
    const aid = aidFromId(id);
    if (!aid) {
      throw new InvalidArgumentError(`Not an article id: ${JSON.stringify(id)}`);
    }
    this.session.assertReady();
    return this.session.run(() =>
      this.guard(async () => {
        const s = this.session;
        await this.boardList(board, true);
        s.send('#');
        await s.waitFor(isAidPrompt, 'the article code prompt');
        s.send(aid.slice(1), Keys.ENTER); // the prompt already shows the '#'
        const outcome = await s.waitFor(
          (l) =>
            isAidPrompt(l) ? false : isAnyKeyPrompt(l) ? 'none' : isBoardList(l) ? 'list' : false,
          'the list after the article code'
        );
        if (outcome === 'none') {
          await s.sendAndWaitChange(Keys.SPACE, 'the list after the notice');
          await s.waitFor((l) => isBoardList(l), 'the list after the notice');
          throw new ArticleNotFoundError();
        }
        await s.flush();
        const list = parseBoardList(s.lines);
        const row = list?.selected;
        if (!list || !row) {
          throw new UnexpectedScreenError('No entry is selected after the code jump', s.snapshot());
        }
        if (isDeletedRow(row)) {
          throw new ArticleDeletedError();
        }
        if ((await this.readPopup(board)).id !== id) {
          throw new ArticleNotFoundError(); // the cursor stayed where it was
        }
        // shortcut: counts pinned rows on this screen only; getArticle's id check catches a wrong guess.
        const pinnedIndex = row.isPinned
          ? list.rows.filter((r) => r.isPinned).findIndex((r) => r.screenRow === row.screenRow)
          : undefined;
        return toSummary(list.board, row, pinnedIndex);
      })
    );
  }

  async getArticle(ref: ArticleRef): Promise<Article> {
    assertRef(ref);
    this.session.assertReady();
    const load = () => this.session.run(() => this.guard(() => this.loadArticle(ref)));
    const article = ref.id
      ? await this.articles.getOrLoad(
          articleKey(ref.board, ref.id),
          this.ttl.article,
          load,
          (a) => a.verified
        )
      : await load();
    return structuredClone(article);
  }

  /** Forget cached results: everything, one board, or one article. */
  invalidate(board?: string, id?: ArticleId): void {
    if (!board) {
      this.pages.clear();
      this.articles.clear();
      this.favorites.clear();
      return;
    }
    const prefix = `${board.toLowerCase()}:`;
    this.pages.deleteWhere((key) => key.startsWith(prefix));
    if (id) {
      this.articles.delete(articleKey(board, id));
    } else {
      this.articles.deleteWhere((key) => key.startsWith(`article:${prefix}`));
    }
  }

  // ---- operations (all run inside the session queue) ----

  /** Main menu, Ctrl-Z, `t`: the hot boards, in PTT's order. Only boards are kept. */
  private async loadHotBoards(): Promise<FavoriteEntry[]> {
    await this.session.toMainMenu();
    this.session.send(Keys.QUICK_SWITCH, 't');
    const rows = await this.readFavoriteRows({ is: isHotBoardsScreen, name: 'hot boards' });
    return rows
      .filter((r) => r.kind === 'board')
      .map((r) => ({
        kind: 'board',
        name: r.name,
        category: r.category,
        title: r.title,
        unread: r.unread,
      }));
  }

  private async loadFavorites(): Promise<FavoriteEntry[]> {
    await this.session.toMainMenu();
    this.session.send('F', Keys.RIGHT);
    return this.readFavoriteLevel(0, { folders: FAVORITES_FOLDER_LIMIT, failed: false });
  }

  /**
   * Reads the favorites list on screen (the top one or a folder): boards, and the folders inside it, which are
   * opened one by one. A folder that cannot be read is left without `entries` instead of failing the whole list,
   * and once one fails no further folder is tried: we may no longer know which level the screen is on.
   */
  private async readFavoriteLevel(
    depth: number,
    budget: { folders: number; failed: boolean }
  ): Promise<FavoriteEntry[]> {
    const rows = await this.readFavoriteRows();
    const entries: FavoriteEntry[] = [];
    for (const row of rows) {
      if (row.kind === 'line') {
        continue;
      }
      if (row.kind === 'board') {
        entries.push({
          kind: 'board',
          name: row.name,
          category: row.category,
          title: row.title,
          unread: row.unread,
        });
        continue;
      }
      const folder: FavoriteEntry = {
        kind: 'folder',
        name: '',
        category: '',
        title: row.title,
        unread: false,
      };
      entries.push(folder);
      if (budget.failed || budget.folders <= 0 || depth >= FAVORITES_DEPTH_LIMIT) {
        continue;
      }
      budget.folders--;
      try {
        folder.entries = await this.readFolder(row, depth, budget);
      } catch (error) {
        if (!(error instanceof WaitTimeoutError || error instanceof UnexpectedScreenError)) {
          throw error;
        }
        budget.failed = true;
      }
    }
    return entries;
  }

  /** Opens the folder in `row`, reads it, and comes back out onto the same row. */
  private async readFolder(
    row: FavoriteRow,
    depth: number,
    budget: { folders: number; failed: boolean }
  ): Promise<FavoriteEntry[]> {
    const s = this.session;
    await this.selectFavorite(row.number);
    const listBefore = s.lines.slice(3, 23).join('\n');
    s.send(Keys.RIGHT);
    await s.flush();
    // The inside of a folder looks like the list around it, so the only sign that it opened is that the rows changed.
    if (s.lines.slice(3, 23).join('\n') === listBefore) {
      throw new UnexpectedScreenError('The favorites folder did not open', s.snapshot());
    }
    const inside = await this.readFavoriteLevel(depth + 1, budget);
    s.send(Keys.LEFT);
    await s.waitFor(
      (l) => (isFavoritesScreen(l) && selectedNumber(l) === row.number ? true : false),
      'the favorites list after leaving a folder'
    );
    return inside;
  }

  /** Types a row number to put the favorites cursor on that row. */
  private async selectFavorite(n: number): Promise<void> {
    if (!isListNumber(n)) {
      throw new InvalidArgumentError(`Not a list number: ${n}`); // never type anything but plain digits
    }
    const s = this.session;
    s.send(String(n), Keys.ENTER);
    const target = await s.waitFor((l) => {
      if (!isFavoritesScreen(l)) {
        return false;
      }
      const selected = parseFavorites(l).find((r) => r.selected);
      return selected?.number === n ? selected : false;
    }, `favorites row ${n} to be selected`);
    if (target.kind !== 'folder') {
      throw new UnexpectedScreenError(
        'The favorites row is not the folder that was expected',
        s.snapshot()
      );
    }
  }

  /** Every row of the board list on screen (favorites, or `list` for the hot boards), all pages, in order. */
  private async readFavoriteRows(
    list: { is: (l: readonly string[]) => boolean; name: string } = {
      is: isFavoritesScreen,
      name: 'favorites',
    }
  ): Promise<FavoriteRow[]> {
    const s = this.session;
    let rows = (
      await s.waitFor(
        (l) => (list.is(l) ? { rows: parseFavorites(l) } : false),
        `the ${list.name} list`
      )
    ).rows;
    const all = new Map(rows.map((r) => [r.number, r]));

    // PTT reopens the list where it was left, so go back up to the first page before reading downwards.
    for (let page = 1; page < FAVORITES_PAGE_LIMIT && rows.length > 0; page++) {
      const lowest = Math.min(...rows.map((r) => r.number));
      if (lowest <= 1) {
        break;
      }
      s.send(Keys.PGUP);
      try {
        rows = await s.waitFor(
          (l) => {
            if (!list.is(l)) {
              return false;
            }
            const previous = parseFavorites(l);
            return previous.some((r) => r.number < lowest) ? previous : false;
          },
          `the previous ${list.name} page`,
          this.nextPageTimeoutMs
        );
      } catch (error) {
        if (error instanceof WaitTimeoutError) {
          break; // already at the top
        }
        throw error;
      }
      for (const r of rows) {
        all.set(r.number, r);
      }
    }

    // A full screen may continue on the next page.
    for (let page = 1; page < FAVORITES_PAGE_LIMIT && rows.length >= LIST_PAGE_SIZE; page++) {
      const highest = Math.max(...rows.map((r) => r.number));
      s.send(Keys.PGDN);
      try {
        rows = await s.waitFor(
          (l) => {
            if (!list.is(l)) {
              return false;
            }
            const next = parseFavorites(l);
            return next.some((r) => r.number > highest) ? next : false;
          },
          `the next ${list.name} page`,
          this.nextPageTimeoutMs
        );
      } catch (error) {
        if (error instanceof WaitTimeoutError) {
          break; // no further page
        }
        throw error;
      }
      for (const r of rows) {
        all.set(r.number, r);
      }
    }

    return [...all.values()].sort((a, b) => a.number - b.number);
  }

  /** From the main menu: `s`, the name, Enter. Returns the list screen, or null if another board (or none) came up. */
  private async enterBoard(board: string): Promise<BoardListScreen | null> {
    const s = this.session;
    await s.toMainMenu();
    s.send('s');
    await s.waitFor(isBoardSelectPrompt, 'the board name prompt');
    s.send(board, Keys.ENTER);

    // A timeout here means a screen we do not know, not a missing board: let it through with its snapshot.
    let list: BoardListScreen | null = null;
    for (let step = 0; step < 4 && !list; step++) {
      const screen = await s.waitFor(
        (l) =>
          isBoardList(l)
            ? 'list'
            : isAnyKeyPrompt(l)
              ? 'anyKey'
              : isMainMenu(l) && !isLogoutConfirm(l)
                ? 'menu' // the prompt closed and the main menu is back: PTT has no such board
                : false,
        'the board screen',
        this.boardEnterTimeoutMs
      );
      if (screen === 'menu') {
        break;
      }
      if (screen === 'anyKey') {
        await s.sendAndWaitChange(Keys.SPACE, 'the board list');
      } else {
        await s.settle(); // the first sight of the list can be half drawn (SSH sends a screen in pieces)
        list = parseBoardList(s.lines);
      }
    }

    if (!list || !sameBoard(list.board, board)) {
      await s.toMainMenu(); // a missing board leaves us on the prompt or on the wrong board
      return null;
    }
    return list;
  }

  /**
   * Runs a search in `board` and returns the results screen, or null when nothing matched. Types only what
   * toSearchInput accepted, answers only prompts found on their fixed last row, and leaves the normal list
   * showing when there are no results.
   */
  private async enterSearch(board: string, query: SearchQuery): Promise<BoardListScreen | null> {
    const input = toSearchInput(query);
    const s = this.session;
    await this.boardList(board, true);
    s.send(input.key);
    await s.waitFor(isSearchPrompt, 'the search prompt');
    s.send(input.text, Keys.ENTER);
    const outcome = await s.waitFor(
      (l) =>
        isBoardList(l, 'search')
          ? 'results'
          : isNoSearchResult(l) && isAnyKeyPrompt(l) && !isSearchPrompt(l)
            ? 'none'
            : false,
      'the search results'
    );
    if (outcome === 'none') {
      await s.sendAndWaitChange(Keys.SPACE, 'the list after the notice');
      await s.waitFor((l) => isBoardList(l), 'the list after the notice');
      return null;
    }
    await s.settle();
    const screen = parseBoardList(s.lines, 'search');
    if (!screen || !sameBoard(screen.board, board)) {
      throw new ArticleMismatchError('The search results belong to another board');
    }
    return screen;
  }

  /** The list screen of `board`; `fresh` re-enters it so the cursor and window are in their entry position. */
  private async boardList(board: string, fresh: boolean): Promise<BoardListScreen> {
    if (!fresh) {
      const current = parseBoardList(this.session.lines);
      if (current && sameBoard(current.board, board)) {
        return current;
      }
    }
    const list = await this.enterBoard(board);
    if (!list) {
      throw new BoardNotFoundError(board);
    }
    return list;
  }

  /** The board's newest page. PTT reopens a board where it was left, so jump to the end instead of trusting entry. */
  private async latestList(board: string): Promise<BoardListScreen> {
    const entered = await this.boardList(board, true);
    this.session.send('$');
    await this.session.flush();
    const end = parseBoardList(this.session.lines);
    return end && sameBoard(end.board, board) ? end : entered;
  }

  /** Typing a number moves the cursor there and scrolls so it sits mid-screen (page = [n-10, n+9]). */
  private async selectNumber(n: number, mode: ListMode = 'normal'): Promise<BoardListScreen> {
    if (!isListNumber(n)) {
      throw new InvalidArgumentError(`Not a list number: ${n}`); // never type anything but plain digits
    }
    const s = this.session;
    const matches = (l: string[]) => {
      const screen = parseBoardList(l, mode);
      return screen?.selected?.number === n ? screen : false;
    };
    const description = `list row ${n} to be selected`;
    const limit = s.settings.stepTimeoutMs;
    const quick = Math.min(600, limit);
    // The cursor row can be drawn before the rows below it (SSH sends a redraw in pieces): let the screen finish,
    // then read the whole list again. Found live on 2026-11-05; WebSocket sends whole screens.
    const complete = async (): Promise<BoardListScreen> => {
      await s.settle();
      const screen = matches(s.lines);
      if (!screen) {
        throw new UnexpectedScreenError(`List row ${n} was selected, then was not`, s.snapshot());
      }
      return screen;
    };

    s.send(String(n), Keys.ENTER);
    try {
      await s.waitFor(matches, description, quick);
      return await complete();
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) {
        throw error;
      }
    }
    // Not selected yet: either the server is slow or the row does not exist (PTT puts the cursor on the last
    // row when the number is past the end, which can leave the screen unchanged). Ask the server to catch up;
    // once it has, where the cursor is is the answer. If it will not say, keep waiting as before.
    if (await s.flush()) {
      const now = matches(s.lines); // flush() has already let the screen settle
      if (now) {
        return now;
      }
      if (parseBoardList(s.lines, mode)?.selected) {
        throw new ArticleMismatchError(`The list has no row ${n} any more`);
      }
    }
    await s.waitFor(matches, description, Math.max(limit - quick, 1000));
    return complete();
  }

  private async loadPage(
    board: string,
    cursor: PageCursor | undefined,
    search?: SearchQuery
  ): Promise<BoardPage> {
    const mode: ListMode = search ? 'search' : 'normal';
    const none: BoardPage = { board, articles: [], pinned: [], hasOlder: false };
    let screen: BoardListScreen;
    if (!cursor) {
      const first = search ? await this.enterSearch(board, search) : await this.latestList(board);
      if (!first) {
        return none;
      }
      screen = first;
    } else if (cursor.before <= 1) {
      return search ? none : { ...none, board: (await this.boardList(board, false)).board };
    } else {
      if (search) {
        if (!(await this.enterSearch(board, search))) {
          return none;
        }
      } else {
        await this.boardList(board, false);
      }
      // Start from the top so the window is known: rows 1..20. Jumping to a row that is already on screen
      // only moves the cursor, so the next target must lie beyond that first screen to make the list scroll
      // (it then shows [target-10, target+9]). If everything we need is on the first screen, use it as is.
      const start = await this.selectNumber(1, mode);
      if (cursor.before - 1 <= LIST_PAGE_SIZE) {
        screen = start;
      } else {
        const target = cursor.before - 10 > LIST_PAGE_SIZE ? cursor.before - 10 : cursor.before - 1;
        screen = await this.selectNumber(target, mode);
      }
    }

    const numbered = screen.rows
      .filter((r) => !r.isPinned && r.number !== undefined && (!cursor || r.number < cursor.before))
      .sort((a, b) => b.number! - a.number!);
    const articles = numbered.map((r) => toSummary(screen.board, r, undefined, search));
    if (cursor && articles[0]?.listNumber !== cursor.before - 1) {
      throw new ArticleMismatchError(
        `The list changed while paging: expected to see row ${cursor.before - 1} next`
      );
    }
    const pinned =
      cursor || search
        ? []
        : screen.rows.filter((r) => r.isPinned).map((r, i) => toSummary(screen.board, r, i));
    const oldest = articles.at(-1)?.listNumber;
    const hasOlder = oldest !== undefined && oldest > 1;
    return {
      board: screen.board,
      articles,
      pinned,
      hasOlder,
      next: hasOlder ? { before: oldest } : undefined,
    };
  }

  /** Puts the list cursor on the entry `ref` points at and returns that row. */
  private async position(ref: ArticleRef): Promise<ListRow> {
    const s = this.session;
    let row: ListRow;
    if (ref.search) {
      if (!(await this.enterSearch(ref.board, ref.search))) {
        throw new ArticleMismatchError('The search has no results any more');
      }
      row = (await this.selectNumber(ref.listNumber!, 'search')).selected!;
    } else if (ref.isPinned) {
      await this.boardList(ref.board, true);
      // PTT returns to where the board was left, so the pinned rows (always last) may be off screen: go to the end.
      s.send('$');
      await s.flush();
      const list = parseBoardList(s.lines);
      const target = list?.rows.filter((r) => r.isPinned)[ref.pinnedIndex!];
      if (!list || !target || !list.selected) {
        throw new ArticleMismatchError('The pinned article is no longer in the list');
      }
      let current = list.selected;
      // The cursor is on the last entry, which is below every pinned row, so it only ever moves up.
      while (current.screenRow > target.screenRow) {
        const wanted = current.screenRow - 1;
        s.send(Keys.UP);
        current = (
          await s.waitFor((l) => {
            const screen = parseBoardList(l);
            return screen?.selected?.screenRow === wanted ? screen : false;
          }, 'the cursor to move up')
        ).selected!;
      }
      row = current;
    } else {
      await this.boardList(ref.board, false);
      row = (await this.selectNumber(ref.listNumber!)).selected!;
    }

    if (
      (ref.title !== undefined && !titlesMatch(row.title, ref.title)) ||
      (ref.author !== undefined && row.author !== ref.author)
    ) {
      throw new ArticleMismatchError(
        'The list changed: the selected entry is not the one that was asked for'
      );
    }
    return row;
  }

  /** `Q` on the selected entry shows its article code and URL; any key closes the box. */
  private async readPopup(board: string, mode: ListMode = 'normal'): Promise<AidPopup> {
    const s = this.session;
    s.send('Q');
    const popup = await s.waitFor(parseAidPopup, 'the article code box');
    s.send(Keys.SPACE);
    await s.waitFor((l) => isBoardList(l, mode), 'the list after the article code box');
    if (!sameBoard(popup.board, board)) {
      throw new ArticleMismatchError(`The article belongs to ${popup.board}, not ${board}`);
    }
    return popup;
  }

  private async loadArticle(ref: ArticleRef): Promise<Article> {
    const s = this.session;
    const row = await this.position(ref);
    // PTT leaves a placeholder row for a deleted article. Enter and Q do nothing on it, so asking would only time out.
    if (isDeletedRow(row)) {
      throw new ArticleDeletedError();
    }
    const mode = listMode(ref);
    const popup = await this.readPopup(ref.board, mode);
    checkId(ref, popup.id);

    const cached = this.articles.get(articleKey(popup.board, popup.id));
    if (cached) {
      return cached;
    }

    s.send(Keys.RIGHT);
    const { pages, truncated } = await this.readPages();
    s.send(Keys.LEFT);
    await s.waitFor((l) => isBoardList(l, mode), 'the list after leaving the article');

    const article = buildArticle(ref, popup, parseArticle(mergePages(pages)), truncated);
    if (article.verified) {
      this.articles.set(articleKey(popup.board, popup.id), article, this.ttl.article);
    }
    return article;
  }

  private async readPages() {
    const s = this.session;
    let page = await s.waitFor(parseArticlePage, 'the article');
    const pages = [page];
    let truncated = false;
    // The page number on the status line counts source lines, so it stops being a page number once long lines
    // wrap. Progress is judged by the lines shown and the percentage, and the end by 100%.
    while (page.status.percent < 100) {
      if (pages.length >= this.maxArticlePages) {
        truncated = true;
        break;
      }
      const before = page.status;
      s.send(Keys.PGDN);
      page = await s.waitFor(
        (l) => {
          const next = parseArticlePage(l);
          return next && (next.status.to > before.to || next.status.from > before.from)
            ? next
            : false;
        },
        `article page ${pages.length + 1}`
      );
      pages.push(page);
    }
    return { pages, truncated };
  }

  /** Runs an operation; if it fails, walk back to the main menu so the next one starts from a known place. */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ConnectionClosedError)) {
        await this.session.toMainMenu().catch(() => {});
      }
      throw error;
    }
  }
}

/** Deleted articles show "-" as the author and a title like "(本文已被刪除) [id]" or "(已被id刪除) <id> title". */
function isDeletedRow(row: ListRow): boolean {
  return row.author === '-' && /^\((?:本文已被刪除|已被.+刪除)\)/.test(row.title);
}

function buildArticle(
  ref: ArticleRef,
  popup: AidPopup,
  parsed: ParsedArticle,
  truncated: boolean
): Article {
  const { header } = parsed;
  const bodyId = parsed.url ? idFromUrl(parsed.url) : undefined;
  // Pinned entries may be edited copies: the list title can differ from the title inside, and the copy may
  // carry the original's URL. That is legitimate for them, so a different URL only marks them as a mirror.
  const pinnedMirror = ref.isPinned === true && bodyId !== undefined && bodyId !== popup.id;

  let verified = false;
  if (header) {
    if (header.board && !sameBoard(header.board, popup.board)) {
      throw new ArticleMismatchError(
        `Opened an article of ${header.board}, expected ${popup.board}`
      );
    }
    if (ref.isPinned) {
      // Right board and a real article screen is all a pinned entry can promise. Picking the right pinned
      // row is guarded earlier, in position(), by the row index and (when given) the list title.
      verified = true;
    } else {
      if (bodyId && bodyId !== popup.id) {
        throw new ArticleMismatchError(
          `Opened article ${bodyId} but the list entry is ${popup.id}`
        );
      }
      verified = bodyId === popup.id; // no URL line in the body: cannot confirm, do not trust or cache it
    }
  }

  return {
    board: popup.board,
    id: popup.id,
    aid: popup.aid,
    url: parsed.url ?? popup.url,
    title: header?.title ?? ref.title ?? '',
    author: header?.author ?? '',
    time: header?.time ?? '',
    bodyLines: parsed.bodyLines,
    pushes: parsed.pushes,
    verified,
    pinnedMirror,
    truncated,
  };
}

function toSummary(
  board: string,
  row: ListRow,
  pinnedIndex?: number,
  search?: SearchQuery
): ArticleSummary {
  return {
    ...(search ? { search } : {}),
    board,
    listNumber: row.number,
    pinnedIndex: row.isPinned ? pinnedIndex : undefined,
    isPinned: row.isPinned,
    title: row.title,
    author: row.author,
    date: row.date,
    push: row.push,
    mark: row.mark,
    kind: row.kind,
  };
}

const articleKey = (board: string, id: ArticleId): string => `article:${board.toLowerCase()}:${id}`;

function checkId(ref: ArticleRef, id: ArticleId): void {
  if (ref.id && ref.id !== id) {
    throw new ArticleMismatchError(
      `The list entry is ${id} but ${ref.id} was expected; the list has changed`
    );
  }
}

/** List titles are cut to the screen width, so one may be a prefix of the other. */
function titlesMatch(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, ' ').trim();
  const y = b.replace(/\s+/g, ' ').trim();
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/** True for a name that is safe to type into PTT's board prompt. */
export function isValidBoardName(name: string): boolean {
  return BOARD_NAME.test(name);
}

function assertBoardName(name: string): void {
  if (!isValidBoardName(name)) {
    throw new InvalidArgumentError(`Not a valid board name: ${JSON.stringify(name)}`);
  }
}

function listMode(ref: ArticleRef): ListMode {
  return ref.search ? 'search' : 'normal';
}

function assertRef(ref: ArticleRef): void {
  assertBoardName(ref.board);
  if (ref.search) {
    toSearchInput(ref.search);
    if (ref.isPinned) {
      throw new InvalidArgumentError('Search results have no pinned articles');
    }
  }
  if (ref.isPinned) {
    if (!Number.isSafeInteger(ref.pinnedIndex) || ref.pinnedIndex! < 0 || ref.pinnedIndex! > 99) {
      throw new InvalidArgumentError('A pinned article needs pinnedIndex (0 to 99)');
    }
  } else if (!isListNumber(ref.listNumber)) {
    throw new InvalidArgumentError(
      `An article needs listNumber (1 to ${MAX_LIST_NUMBER}) or isPinned`
    );
  }
}

/** Numbers are typed into the list as digits, so they must be plain integers (no "1e+21") and bounded. */
function isListNumber(n: number | undefined): n is number {
  return Number.isSafeInteger(n) && n! >= 1 && n! <= MAX_LIST_NUMBER;
}
