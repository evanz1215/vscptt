import { TtlCache } from './cache/ttlCache';
import {
  ArticleDeletedError,
  ArticleMismatchError,
  BoardNotFoundError,
  ConnectionClosedError,
  InvalidArgumentError,
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
} from './models';
import { WaitTimeoutError } from './queue/waitFor';
import { type AidPopup, idFromUrl, parseAidPopup } from './screens/aidPopup';
import { type ParsedArticle, mergePages, parseArticle, parseArticlePage } from './screens/article';
import {
  type BoardListScreen,
  type ListRow,
  isBoardList,
  parseBoardList,
  sameBoard,
} from './screens/boardList';
import { isFavoritesScreen, parseFavorites } from './screens/favorites';
import {
  isAnyKeyPrompt,
  isBoardSelectPrompt,
  isLogoutConfirm,
  isMainMenu,
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
const LIST_PAGE_SIZE = 20;
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
    session.onStateChange((state) => {
      if (state === 'disconnected') {
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

  /** Finds the stable id of a list entry (press `Q` on it). */
  async resolveArticleId(ref: ArticleRef): Promise<ResolvedArticle> {
    assertRef(ref);
    this.session.assertReady();
    return this.session.run(() =>
      this.guard(async () => {
        await this.position(ref);
        const popup = await this.readPopup(ref.board);
        checkId(ref, popup.id);
        return { board: popup.board, id: popup.id, aid: popup.aid, url: popup.url };
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

  private async loadFavorites(): Promise<FavoriteEntry[]> {
    const s = this.session;
    await s.toMainMenu();
    s.send('F', Keys.RIGHT);
    let rows = (
      await s.waitFor(
        (l) => (isFavoritesScreen(l) ? { rows: parseFavorites(l) } : false),
        'the favorites list'
      )
    ).rows;
    const all = new Map(rows.map((r) => [r.number, r]));

    // A full screen may continue on the next page.
    for (let page = 1; page < FAVORITES_PAGE_LIMIT && rows.length >= LIST_PAGE_SIZE; page++) {
      const highest = Math.max(...rows.map((r) => r.number));
      s.send(Keys.PGDN);
      try {
        rows = await s.waitFor(
          (l) => {
            if (!isFavoritesScreen(l)) {
              return false;
            }
            const next = parseFavorites(l);
            return next.some((r) => r.number > highest) ? next : false;
          },
          'the next favorites page',
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

    return [...all.values()]
      .sort((a, b) => a.number - b.number)
      .map((r) => ({ name: r.name, category: r.category, title: r.title, unread: r.unread }));
  }

  /** From the main menu: `s`, the name, Enter. Returns the list screen, or null if another board (or none) came up. */
  private async enterBoard(board: string): Promise<BoardListScreen | null> {
    const s = this.session;
    await s.toMainMenu();
    s.send('s');
    await s.waitFor(isBoardSelectPrompt, 'the board name prompt');
    s.send(board, Keys.ENTER);

    let list: BoardListScreen | null = null;
    try {
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
          list = parseBoardList(s.lines);
        }
      }
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) {
        throw error;
      }
    }

    if (!list || !sameBoard(list.board, board)) {
      await s.toMainMenu(); // a missing board leaves us on the prompt or on the wrong board
      return null;
    }
    return list;
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

  /** Typing a number moves the cursor there and scrolls so it sits mid-screen (page = [n-10, n+9]). */
  private async selectNumber(n: number): Promise<BoardListScreen> {
    if (!isListNumber(n)) {
      throw new InvalidArgumentError(`Not a list number: ${n}`); // never type anything but plain digits
    }
    const s = this.session;
    const matches = (l: string[]) => {
      const screen = parseBoardList(l);
      return screen?.selected?.number === n ? screen : false;
    };
    const description = `list row ${n} to be selected`;
    const limit = s.settings.stepTimeoutMs;
    const quick = Math.min(600, limit);

    s.send(String(n), Keys.ENTER);
    try {
      return await s.waitFor(matches, description, quick);
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) {
        throw error;
      }
    }
    // Not selected yet: either the server is slow or the row does not exist (PTT puts the cursor on the last
    // row when the number is past the end, which can leave the screen unchanged). Ask the server to catch up;
    // once it has, where the cursor is is the answer. If it will not say, keep waiting as before.
    if (await s.flush()) {
      const now = matches(s.lines);
      if (now) {
        return now;
      }
      if (parseBoardList(s.lines)?.selected) {
        throw new ArticleMismatchError(`The list has no row ${n} any more`);
      }
    }
    return s.waitFor(matches, description, Math.max(limit - quick, 1000));
  }

  private async loadPage(board: string, cursor: PageCursor | undefined): Promise<BoardPage> {
    let screen: BoardListScreen;
    if (!cursor) {
      screen = await this.boardList(board, true);
    } else if (cursor.before <= 1) {
      screen = await this.boardList(board, false);
      return { board: screen.board, articles: [], pinned: [], hasOlder: false };
    } else {
      await this.boardList(board, false);
      // Start from the top so the window is known: rows 1..20. Jumping to a row that is already on screen
      // only moves the cursor, so the next target must lie beyond that first screen to make the list scroll
      // (it then shows [target-10, target+9]). If everything we need is on the first screen, use it as is.
      const start = await this.selectNumber(1);
      if (cursor.before - 1 <= LIST_PAGE_SIZE) {
        screen = start;
      } else {
        const target = cursor.before - 10 > LIST_PAGE_SIZE ? cursor.before - 10 : cursor.before - 1;
        screen = await this.selectNumber(target);
      }
    }

    const numbered = screen.rows
      .filter((r) => !r.isPinned && r.number !== undefined && (!cursor || r.number < cursor.before))
      .sort((a, b) => b.number! - a.number!);
    const articles = numbered.map((r) => toSummary(screen.board, r));
    if (cursor && articles[0]?.listNumber !== cursor.before - 1) {
      throw new ArticleMismatchError(
        `The list changed while paging: expected to see row ${cursor.before - 1} next`
      );
    }
    const pinned = cursor
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
    if (ref.isPinned) {
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
  private async readPopup(board: string): Promise<AidPopup> {
    const s = this.session;
    s.send('Q');
    const popup = await s.waitFor(parseAidPopup, 'the article code box');
    s.send(Keys.SPACE);
    await s.waitFor((l) => isBoardList(l), 'the list after the article code box');
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
    const popup = await this.readPopup(ref.board);
    checkId(ref, popup.id);

    const cached = this.articles.get(articleKey(popup.board, popup.id));
    if (cached) {
      return cached;
    }

    s.send(Keys.RIGHT);
    const { pages, truncated } = await this.readPages();
    s.send(Keys.LEFT);
    await s.waitFor((l) => isBoardList(l), 'the list after leaving the article');

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

function toSummary(board: string, row: ListRow, pinnedIndex?: number): ArticleSummary {
  return {
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

function assertRef(ref: ArticleRef): void {
  assertBoardName(ref.board);
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
