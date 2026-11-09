import { aidFromId } from '../../src/core/aid';
import { FakeTransport } from './fakeTransport';

/**
 * A small imitation of the PTT terminal UI, built from what was observed on the live server (2026-11-03):
 * login screens, main menu, favorites, the board-name prompt, the list window rules (entry anchored to the
 * bottom, a number jump centres the target), the `Q` box, multi-page articles with repeated rows, logout.
 * It is not a PTT emulator; it only needs to be faithful where the client depends on it.
 */

export interface FakeArticle {
  id: string;
  number?: number;
  pinned?: boolean;
  author: string;
  title: string;
  date?: string;
  push?: string;
  /** Number of boos, for the push-count search with a negative threshold. */
  boo?: number;
  mark?: string;
  kind?: 'normal' | 'reply' | 'deleted';
  body?: string[];
  pushes?: Array<{ kind: '推' | '噓' | '→'; user: string; text: string; date?: string }>;
  /** Title shown inside the article when it differs from the list (edited pinned entries). */
  headerTitle?: string;
  /** Article id written in the body's "文章網址" line. Default: own id. null: leave the line out. */
  bodyUrlId?: string | null;
  /** Board shown in the article header. Default: the board being read. */
  headerBoard?: string;
}

export interface FakeBbsOptions {
  users?: Record<string, string>;
  boards?: Record<string, FakeArticle[]>;
  favorites?: string[];
  /** What is inside each favorites folder, by the entry that names it (`FOLDER + title`). May nest. */
  folders?: Record<string, string[]>;
  duplicateLogin?: boolean;
  deleteAttempts?: boolean;
  frequentNotice?: boolean;
  tryLater?: boolean;
  /** Typed name -> board actually entered (PTT completes names loosely). */
  autocomplete?: Record<string, string>;
  /** `#` and a code leave the cursor where it was, with no notice (the case the `Q` check exists for). */
  aidJumpIgnored?: boolean;
  /** Send each screen in pieces a little apart, as SSH does (seen live 2026-11-05). */
  splitFrames?: boolean;
  /** Boards whose entry screen has a footer the client does not know (no 任意鍵). */
  oddWelcome?: string[];
}

type Mode =
  | 'splash'
  | 'password'
  | 'duplicate'
  | 'deleteAttempts'
  | 'notice'
  | 'welcome'
  | 'main'
  | 'favorites'
  | 'select'
  | 'boardWelcome'
  | 'list'
  | 'searchPrompt'
  | 'aidPrompt'
  | 'aidNotFound'
  | 'noResult'
  | 'popup'
  | 'article'
  | 'logoutConfirm'
  | 'namelist'
  | 'goodbye'
  | 'closed';

const WINDOW = 20;
/** Favorites entries that are not boards: `FOLDER + title` is a folder, `LINE` is a separator. */
export const FOLDER = 'folder:';
export const LINE = '---';

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6);

/** Cut a row to 79 cells so it never wraps and scrolls the 80x24 screen. */
function fit(row: string): string {
  let cells = 0;
  let out = '';
  for (const ch of row) {
    const w = isWide(ch.codePointAt(0)!) ? 2 : 1;
    if (cells + w > 79) {
      break;
    }
    cells += w;
    out += ch;
  }
  return out;
}

const frame = (rows: string[]): string =>
  '\x1b[2J\x1b[H' + Array.from({ length: 24 }, (_, i) => fit(rows[i] ?? '')).join('\r\n');

function tokenize(data: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < data.length;) {
    // eslint-disable-next-line no-control-regex
    const m = /^\x1b\[(\d?)([~A-D])/.exec(data.slice(i));
    if (m) {
      const map: Record<string, string> = {
        D: 'LEFT',
        C: 'RIGHT',
        A: 'UP',
        B: 'DOWN',
        '5~': 'PGUP',
        '6~': 'PGDN',
      };
      keys.push(map[`${m[1]}${m[2]}`] ?? 'UNKNOWN');
      i += m[0].length;
      continue;
    }
    const ch = data[i]!;
    keys.push(
      ch === '\r'
        ? 'ENTER'
        : ch === '\x08' || ch === '\x7f'
          ? 'BACKSPACE'
          : ch === '\x0c'
            ? 'REDRAW'
            : ch
    );
    i++;
  }
  return keys;
}

/** The real code for ordinary ids; a made-up one for the odd ids some tests use. */
const aidOf = (a: FakeArticle): string =>
  aidFromId(a.id) ?? `#1${Buffer.from(a.id).toString('hex').slice(0, 7)}`;

export class FakeBbs {
  readonly options: Required<FakeBbsOptions>;
  /** What the server saw in answer to the duplicate-login / attempts prompts. */
  duplicateAnswer: string | undefined;
  deleteAttemptsAnswer: string | undefined;
  loggedInAs: string | undefined;

  private transport!: FakeTransport;
  private mode: Mode = 'splash';
  private buffer = '';
  private user = '';
  private pipeline: Mode[] = [];
  private menuCursor = '';
  private currentBoard = '';
  private listParent: 'main' | 'favorites' = 'main';
  /** Observed: PTT puts you back where you left a board, not at its end. */
  private readonly lastPosition = new Map<string, { cursor: number; top: number }>();
  /** The favorites list and the folders opened inside it; the last one is on screen. */
  private readonly favoriteLevels: Array<{
    names: string[];
    cursor: number;
    top: number;
    /** The row that opened this level, so Left puts the cursor back on it. */
    from?: number;
  }> = [];
  private items: FakeArticle[] = [];
  private cursor = 0;
  private top = 0;
  private articleLines: string[] = [];
  private articleStart = 0;
  private currentArticle: FakeArticle | undefined;
  /** Observed: after a search the list shows only the matches ("系列"), numbered 1..N, until Left. */
  private searching = false;
  private saved: { items: FakeArticle[]; cursor: number; top: number } | undefined;
  private searchKey = '';
  /** Every search the client typed, as [key, text]. */
  readonly searches: Array<[string, string]> = [];

  constructor(options: FakeBbsOptions = {}) {
    this.options = {
      users: options.users ?? { alice: 'secret' },
      boards: options.boards ?? {},
      favorites: options.favorites ?? [],
      folders: options.folders ?? {},
      duplicateLogin: options.duplicateLogin ?? false,
      deleteAttempts: options.deleteAttempts ?? false,
      frequentNotice: options.frequentNotice ?? false,
      tryLater: options.tryLater ?? false,
      autocomplete: options.autocomplete ?? {},
      aidJumpIgnored: options.aidJumpIgnored ?? false,
      splitFrames: options.splitFrames ?? false,
      oddWelcome: options.oddWelcome ?? [],
    };
    for (const articles of Object.values(this.options.boards)) {
      FakeBbs.renumber(articles);
    }
  }

  /** Creates a transport wired to this server and plays the splash screen. */
  connect(): FakeTransport {
    this.transport = new FakeTransport((data) => this.input(data));
    // Delivered a tick later, like a real server's first bytes arriving after the connection opens.
    queueMicrotask(() => this.render());
    return this.transport;
  }

  /** Change a board's articles (to simulate the list changing under the client). */
  mutate(board: string, change: (articles: FakeArticle[]) => void): void {
    const articles = this.options.boards[board]!;
    change(articles);
    FakeBbs.renumber(articles);
  }

  get screenMode(): string {
    return this.mode;
  }

  static renumber(articles: FakeArticle[]): void {
    let n = 0;
    for (const a of articles) {
      a.number = a.pinned ? undefined : ++n;
    }
  }

  // ---- input ----

  private input(data: string): void {
    for (const key of tokenize(data)) {
      this.onKey(key);
      if (this.mode === 'closed') {
        return;
      }
    }
  }

  private isText(key: string): boolean {
    return key.length === 1;
  }

  private onKey(key: string): void {
    switch (this.mode) {
      case 'splash':
      case 'password':
      case 'duplicate':
      case 'deleteAttempts':
      case 'select':
      case 'searchPrompt':
      case 'aidPrompt':
      case 'logoutConfirm':
        return this.onLine(key);
      case 'noResult':
      case 'aidNotFound':
        this.mode = 'list';
        return this.render();
      case 'notice':
        if (key === 'ENTER') this.nextAfterLogin();
        return;
      case 'welcome':
        return this.nextAfterLogin();
      case 'boardWelcome':
        this.mode = 'list';
        return this.render();
      case 'popup':
        this.mode = 'list';
        return this.render();
      case 'goodbye':
        this.mode = 'closed';
        this.transport.serverClose({ code: 1000, reason: 'bbs disconnected' });
        return;
      case 'main':
        return this.onMain(key);
      case 'namelist':
        // A harmless menu that a stray 'n' + Enter on the main menu opens on the real server too.
        if (key === 'LEFT') this.mode = 'main';
        return this.render();
      case 'favorites':
        return this.onFavorites(key);
      case 'list':
        return this.onList(key);
      case 'article':
        return this.onArticle(key);
      case 'closed':
        return;
    }
  }

  /** Modes that read a line of text. */
  private onLine(key: string): void {
    if (key === 'ENTER') {
      const line = this.buffer;
      this.buffer = '';
      return this.submitLine(line);
    }
    if (key === 'BACKSPACE') {
      this.buffer = '';
      return this.echo();
    }
    if (this.isText(key)) {
      this.buffer += key;
      this.echo();
    }
  }

  /** Prompts show what is typed, so merely typing changes the screen. */
  private echo(): void {
    if (
      [
        'select',
        'duplicate',
        'deleteAttempts',
        'logoutConfirm',
        'searchPrompt',
        'aidPrompt',
      ].includes(this.mode)
    ) {
      this.render();
    }
  }

  private submitLine(line: string): void {
    switch (this.mode) {
      case 'splash': {
        const user = line.replace(/,$/, '');
        if (!(user in this.options.users)) {
          this.screen(['', '無此帳號。請檢查大小寫及有無輸入錯誤。', 'login with guest or new:']);
          return;
        }
        this.user = user;
        this.mode = 'password';
        return this.render();
      }
      case 'password': {
        if (this.options.users[this.user] !== line) {
          this.mode = 'splash';
          this.screen([
            '',
            '密碼不對或無此帳號。請檢查大小寫及有無輸入錯誤。',
            'login with guest or new:',
          ]);
          return;
        }
        if (this.options.tryLater) {
          this.mode = 'closed';
          this.screen(['', '請稍後再試。']);
          this.transport.serverClose({ code: 1000 });
          return;
        }
        this.loggedInAs = this.user;
        this.pipeline = [
          ...(this.options.deleteAttempts ? (['deleteAttempts'] as Mode[]) : []),
          ...(this.options.duplicateLogin ? (['duplicate'] as Mode[]) : []),
          ...(this.options.frequentNotice ? (['notice'] as Mode[]) : []),
          'welcome',
          'main',
        ];
        return this.nextAfterLogin();
      }
      case 'duplicate':
        this.duplicateAnswer = line;
        if (line.toLowerCase() === 'n') {
          // Observed on the live server: declining to remove the other connection ends this one.
          this.mode = 'closed';
          this.transport.serverClose({ code: 1000, reason: 'bbs disconnected' });
          return;
        }
        return this.nextAfterLogin();
      case 'deleteAttempts':
        this.deleteAttemptsAnswer = line;
        return this.nextAfterLogin();
      case 'select':
        return this.submitBoardName(line);
      case 'searchPrompt':
        return this.submitSearch(line);
      case 'aidPrompt':
        return this.submitAid(line);
      case 'logoutConfirm':
        this.mode = line.toLowerCase() === 'y' ? 'goodbye' : 'main';
        return this.render();
    }
  }

  private nextAfterLogin(): void {
    this.mode = this.pipeline.shift() ?? 'main';
    this.render();
  }

  private onMain(key: string): void {
    if (key === 's') {
      this.mode = 'select';
      this.buffer = '';
      return this.render();
    }
    if (key === 'LEFT') {
      this.mode = 'logoutConfirm';
      return this.render();
    }
    if (key === 'REDRAW') return this.render();
    if (this.isText(key)) {
      this.menuCursor = key.toUpperCase();
      return;
    }
    if (key === 'RIGHT' || key === 'ENTER') {
      if (this.menuCursor === 'F') {
        // Like PTT, the favorites list comes back on the page and row where it was left.
        this.mode = 'favorites';
        this.favoriteLevels.length = Math.min(this.favoriteLevels.length, 1);
        this.render();
      } else if (this.menuCursor === 'N') {
        this.mode = 'namelist';
        this.render();
      } else if (this.menuCursor === 'G') {
        this.mode = 'logoutConfirm';
        this.render();
      }
    }
  }

  /** The level on screen. The list is created on first use and, like PTT, remembers where it was left. */
  private get fav() {
    if (this.favoriteLevels.length === 0) {
      this.favoriteLevels.push({ names: this.options.favorites, cursor: 0, top: 0 });
    }
    return this.favoriteLevels[this.favoriteLevels.length - 1]!;
  }

  private onFavorites(key: string): void {
    const level = this.fav;
    const names = level.names;
    if (/^\d$/.test(key)) {
      this.buffer += key; // a row number, finished with Enter
      return;
    }
    if (key === 'ENTER' && /^\d+$/.test(this.buffer)) {
      const row = Math.min(Math.max(Number(this.buffer), 1), names.length) - 1;
      this.buffer = '';
      level.cursor = row;
      level.top = Math.floor(row / WINDOW) * WINDOW;
      this.render();
      return;
    }
    this.buffer = '';
    if (key === 'RIGHT' || key === 'ENTER') {
      const name = names[level.cursor];
      if (name?.startsWith(FOLDER)) {
        this.favoriteLevels.push({
          names: this.options.folders?.[name] ?? [],
          cursor: 0,
          top: 0,
          from: level.cursor,
        });
        this.render();
      } else if (name && name !== LINE) {
        this.listParent = 'favorites';
        this.beginBoard(name);
      }
      return;
    }
    if (key === 'LEFT') {
      if (this.favoriteLevels.length > 1) {
        this.favoriteLevels.pop();
      } else {
        this.mode = 'main';
      }
    } else if (key === 'DOWN') {
      level.cursor = Math.min(level.cursor + 1, names.length - 1);
      if (level.cursor >= level.top + WINDOW) level.top += WINDOW;
    } else if (key === 'UP') {
      level.cursor = Math.max(level.cursor - 1, 0);
      if (level.cursor < level.top) level.top -= WINDOW;
    } else if (key === 'PGDN') {
      // PTT wraps: on the last page it goes back to the first row.
      if (level.top + WINDOW < names.length) {
        level.top += WINDOW;
        level.cursor = level.top;
      } else {
        level.top = 0;
        level.cursor = 0;
      }
    } else if (key === 'PGUP') {
      if (level.top === 0) {
        level.top = Math.max(Math.floor((names.length - 1) / WINDOW), 0) * WINDOW;
        level.cursor = Math.max(names.length - 1, 0);
      } else {
        level.top = Math.max(level.top - WINDOW, 0);
        level.cursor = level.top;
      }
    } else if (key !== 'REDRAW') {
      return;
    }
    this.render();
  }

  private submitBoardName(typed: string): void {
    const name = this.options.autocomplete[typed] ?? typed;
    const board = Object.keys(this.options.boards).find(
      (b) => b.toLowerCase() === name.toLowerCase()
    );
    if (typed === '' || !board) {
      this.mode = 'main'; // an empty or unknown name just returns to the menu
      return this.render();
    }
    this.listParent = 'main';
    this.beginBoard(board);
  }

  private beginBoard(board: string): void {
    this.currentBoard = board;
    const all = this.options.boards[board]!;
    const normals = all.filter((a) => !a.pinned).sort((a, b) => a.number! - b.number!);
    this.items = [...normals, ...all.filter((a) => a.pinned)];
    this.cursor = Math.max(normals.length - 1, 0);
    this.top = Math.max(this.items.length - WINDOW, 0);
    const remembered = this.lastPosition.get(board);
    if (remembered) {
      ({ cursor: this.cursor, top: this.top } = remembered);
    }
    this.searching = false;
    this.saved = undefined;
    this.buffer = '';
    this.mode = 'boardWelcome';
    this.render();
  }

  private onList(key: string): void {
    if (key === 'ENTER' && /^\d+$/.test(this.buffer)) {
      return this.jump(Number(this.buffer));
    }
    if (/^\d$/.test(key)) {
      this.buffer += key;
      return;
    }
    this.buffer = '';
    switch (key) {
      case 'DOWN':
        this.cursor = Math.min(this.cursor + 1, this.items.length - 1);
        if (this.cursor >= this.top + WINDOW) this.top = this.cursor - WINDOW + 1;
        return this.render();
      case 'UP':
        this.cursor = Math.max(this.cursor - 1, 0);
        if (this.cursor < this.top) this.top = this.cursor;
        return this.render();
      case '/':
      case 'a':
      case 'Z':
        this.searchKey = key;
        this.mode = 'searchPrompt';
        return this.render();
      case 'LEFT':
        if (this.searching && this.saved) {
          ({ items: this.items, cursor: this.cursor, top: this.top } = this.saved);
          this.searching = false;
          this.saved = undefined;
          return this.render();
        }
        this.lastPosition.set(this.currentBoard, { cursor: this.cursor, top: this.top });
        this.mode = this.listParent;
        return this.render();
      case '$': // the last entry (a pinned one if there are any)
        this.cursor = this.items.length - 1;
        this.top = Math.max(this.items.length - WINDOW, 0);
        return this.render();
      case '#':
        this.mode = 'aidPrompt';
        return this.render();
      case 'Q':
        this.mode = 'popup';
        return this.render();
      case 's':
        this.mode = 'select';
        this.buffer = '';
        return this.render();
      case 'RIGHT':
      case 'ENTER':
        return this.openArticle();
      case 'REDRAW':
        return this.render();
    }
  }

  private submitSearch(text: string): void {
    this.buffer = '';
    this.mode = 'list';
    if (text === '') {
      return this.render(); // an empty answer cancels
    }
    this.searches.push([this.searchKey, text]);
    const needle = text.toLowerCase();
    const pushOf = (a: FakeArticle) => (a.push === '爆' ? 100 : Number(a.push || 0));
    const matches = this.items.filter((a) => {
      if (a.pinned) return false;
      if (this.searchKey === '/') return a.title.toLowerCase().includes(needle);
      if (this.searchKey === 'a') return a.author.toLowerCase().includes(needle);
      const n = Number(text);
      return n >= 0 ? pushOf(a) > n : (a.boo ?? 0) > -n;
    });
    if (matches.length === 0) {
      this.mode = 'noResult';
      return this.render();
    }
    if (!this.searching) {
      this.saved = { items: this.items, cursor: this.cursor, top: this.top };
    }
    this.searching = true;
    this.items = matches;
    this.cursor = matches.length - 1;
    this.top = Math.max(matches.length - WINDOW, 0);
    this.render();
  }

  /** Every article code the client typed after `#`. */
  readonly aidSearches: string[] = [];

  private submitAid(text: string): void {
    this.buffer = '';
    this.mode = 'list';
    if (text === '') {
      return this.render();
    }
    this.aidSearches.push(text);
    if (this.options.aidJumpIgnored) {
      return this.render();
    }
    const idx = this.items.findIndex((a) => aidOf(a) === `#${text}`);
    if (idx < 0) {
      this.mode = 'aidNotFound';
      return this.render();
    }
    this.cursor = idx;
    if (idx < this.top || idx >= this.top + WINDOW) {
      this.top = Math.max(idx - 10, 0);
    }
    this.render();
  }

  /** The number PTT shows: the article's own, or its position among the results after a search. */
  private numberOf(a: FakeArticle): number | undefined {
    return this.searching ? this.items.indexOf(a) + 1 : a.number;
  }

  /** Observed: a number jump moves the cursor; the window only scrolls if the target is off screen. */
  private jump(n: number): void {
    let idx = this.items.findIndex((a) => this.numberOf(a) === n);
    if (idx < 0) {
      idx = n > 0 ? this.items.length - 1 : 0;
    }
    this.cursor = idx;
    if (idx < this.top || idx >= this.top + WINDOW) {
      this.top = Math.max(idx - 10, 0);
    }
    this.buffer = '';
    this.render();
  }

  private openArticle(): void {
    const article = this.items[this.cursor];
    if (!article) return;
    this.currentArticle = article;
    this.articleLines = this.buildArticle(article);
    this.articleStart = 0;
    this.mode = 'article';
    this.render();
  }

  private buildArticle(a: FakeArticle): string[] {
    const board = a.headerBoard ?? this.currentBoard;
    const url =
      a.bodyUrlId === null
        ? []
        : [`※ 文章網址: https://www.ptt.cc/bbs/${this.currentBoard}/${a.bodyUrlId ?? a.id}.html`];
    return [
      ` 作者  ${a.author} (nick)                                  看板  ${board}`,
      ` 標題  ${a.headerTitle ?? a.title}`,
      ' 時間  Sun Nov  1 10:17:18 2026',
      '─ '.repeat(38),
      ...(a.body ?? ['line one', 'line two', 'line three']),
      '--',
      '※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 0.0.0.0 (臺灣)',
      ...url,
      ...(a.pushes ?? []).map(
        (p) => `${p.kind} ${p.user}: ${p.text}    ${p.date ?? '11/01'} 12:00`
      ),
    ];
  }

  private pageInfo() {
    const total = this.articleLines.length;
    const pages = total <= 23 ? 1 : 1 + Math.ceil((total - 23) / 22);
    const starts = Array.from({ length: pages }, (_, p) =>
      p === 0 ? 0 : Math.min(p * 22, total - 23)
    );
    return { total, pages, starts };
  }

  private onArticle(key: string): void {
    const { pages, starts } = this.pageInfo();
    const page = starts.indexOf(this.articleStart);
    if (key === 'PGDN' && page < pages - 1) {
      this.articleStart = starts[page + 1]!;
    } else if (key === 'PGUP' && page > 0) {
      this.articleStart = starts[page - 1]!;
    } else if (key === 'LEFT') {
      this.mode = 'list';
    } else if (key !== 'REDRAW') {
      return;
    }
    this.render();
  }

  // ---- rendering ----

  /** Keeps split screens in order: a piece never overtakes the rest of the screen before it. */
  private sending = Promise.resolve();

  private screen(rows: string[]): void {
    if (!this.options.splitFrames) {
      return this.transport.push(frame(rows));
    }
    // Like PTT over SSH: rows are rewritten in place (no clear), so the rows not reached yet still show the
    // previous screen, and the list's header and footer are there the whole time.
    const data =
      '\x1b[H' + Array.from({ length: 24 }, (_, i) => `${fit(rows[i] ?? '')}\x1b[K`).join('\r\n');
    // Four pieces, so a list's cursor row can arrive before the rows under it.
    const size = Math.ceil(data.length / 4);
    this.sending = this.sending.then(async () => {
      for (let i = 0; i < data.length; i += size) {
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 15)); // well under the client's quiet time
        }
        this.transport.push(data.slice(i, i + size));
      }
    });
  }

  private render(): void {
    switch (this.mode) {
      case 'splash':
        return this.screen(['Welcome to the fake BBS', '', 'login with guest or new:']);
      case 'password':
        return this.screen(['', '請輸入您的密碼: ']);
      case 'duplicate':
        return this.screen(['', `您想刪除其他重複登入的連線嗎？[Y/n] ${this.buffer}`]);
      case 'deleteAttempts':
        return this.screen(['', `您要刪除以上錯誤嘗試的記錄嗎？[Y/n] ${this.buffer}`]);
      case 'notice':
        return this.screen([
          '',
          '請勿頻繁登入以免造成系統過度負荷',
          ...Array(20).fill(''),
          '請按 Enter 繼續',
        ]);
      case 'welcome':
        return this.screen([...Array(22).fill(''), '', ' ▄ ▄ ▄  請按任意鍵繼續 ▄ ▄ ▄']);
      case 'main':
        return this.screen(this.mainRows());
      case 'favorites':
        return this.screen(this.favoriteRows());
      case 'select':
        return this.screen(['【 選擇看板 】', `請輸入看板名稱(按空白鍵自動搜尋): ${this.buffer}`]);
      case 'boardWelcome':
        return this.screen([
          ...Array(23).fill(''),
          this.options.oddWelcome.includes(this.currentBoard!)
            ? '  瀏覽 第 1/2 頁 (50%)  目前顯示: 第 01~23 行'
            : ' ▄ ▄ ▄  請按任意鍵繼續 ▄ ▄ ▄',
        ]);
      case 'list':
        return this.screen(this.listRows());
      case 'searchPrompt': {
        const rows = this.listRows();
        const label =
          this.searchKey === '/'
            ? '搜尋標題:'
            : this.searchKey === 'a'
              ? '搜尋作者:'
              : '搜尋推文數高於多少 (<0則搜噓文數) 的文章:';
        rows[23] = `${label} ${this.buffer}`;
        return this.screen(rows);
      }
      case 'aidPrompt': {
        const rows = this.listRows();
        rows[23] = `搜尋文章代碼(AID): #${this.buffer}`;
        return this.screen(rows);
      }
      case 'aidNotFound': {
        const rows = this.listRows();
        rows[23] =
          ' ◆  找不到這個文章代碼(AID)，可能是文章已消失，或是你找錯看板了  [按任意鍵繼續]';
        return this.screen(rows);
      }
      case 'noResult': {
        const rows = this.listRows();
        rows[23] = ' ◆  找不到符合條件的文章。                                      [按任意鍵繼續]';
        return this.screen(rows);
      }
      case 'popup': {
        const rows = this.listRows();
        const a = this.items[this.cursor]!;
        const aid = aidOf(a);
        rows[10] = '┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐';
        rows[11] = `│  文章代碼(AID): ${aid} (${this.currentBoard}) [ptt.cc] ${a.title} │`;
        rows[12] = `│  文章網址: https://www.ptt.cc/bbs/${this.currentBoard}/${a.id}.html  │`;
        rows[13] = '│  這一篇文章值 10 Ptt幣 │';
        rows[14] = '└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘';
        rows[23] = ' ▄ ▄ ▄  請按任意鍵繼續 ▄ ▄ ▄';
        return this.screen(rows);
      }
      case 'article':
        return this.screen(this.articleRows());
      case 'logoutConfirm':
        return this.screen([
          ...this.mainRows().slice(0, 22),
          `您確定要離開【 批踢踢實業坊 】嗎(Y/N)？[N] ${this.buffer}`,
          this.mainRows()[23]!,
        ]);
      case 'goodbye':
        return this.screen([
          ...Array(23).fill(''),
          ' ◆  此次停留時間: 0 小時  1 分            [按任意鍵繼續]',
        ]);
      case 'namelist': {
        const rows = Array(24).fill('');
        rows[0] = '【編特別名單】                   批踢踢實業坊';
        rows[23] = ' 名單編輯  [ 天秤時 ]    11/3 週二 12:48 | tester     (← )回到上層 (h)說明';
        return this.screen(rows);
      }
      case 'closed':
        return;
    }
  }

  private mainRows(): string[] {
    const rows = Array(24).fill('');
    rows[0] = '【主功能表】                     批踢踢實業坊';
    rows[12] = '  (A)nnounce     【 精華公佈欄 】';
    rows[13] = '  (F)avorite     【 我 的 最愛 】';
    rows[14] = '  (G)oodbye         離開，再見…';
    rows[15] = '  (N)amelist     【 編特別名單 】';
    rows[23] = ` 主選單  [ 處女時 ]    11/3 週二 12:12 | ${this.loggedInAs ?? ''} | 線上30000人`;
    return rows;
  }

  private favoriteRows(): string[] {
    const rows = Array(24).fill('');
    rows[0] = '【看板列表】                     批踢踢實業坊';
    rows[1] = '[y]列出全部 [→ ]進入 [s]找看板 [/]搜尋';
    rows[2] = '   編號   看  板       類別   中   文   敘   述';
    const level = this.fav;
    level.names.slice(level.top, level.top + WINDOW).forEach((name, k) => {
      const i = level.top + k;
      const cursor = i === level.cursor ? '>' : ' ';
      // Drawn like mbbsd/board.c: a folder is `MyFavFolder  目錄 ◎title`, a separator is a run of dashes.
      rows[3 + k] =
        name === LINE
          ? `${cursor}${String(i + 1).padStart(6)}   ${'-'.repeat(12)}      ${'-'.repeat(42)}`
          : name.startsWith(FOLDER)
            ? `${cursor}${String(i + 1).padStart(6)}   MyFavFolder  目錄 ◎${name.slice(FOLDER.length)}`
            : `${cursor}${String(i + 1).padStart(6)} ˇ ${name.padEnd(13)} 綜合 ◎ [${name}] ${name} 板`;
    });
    rows[23] = ' 我的最愛  (a)增加看板 (d)刪除 (g)新增目錄 (← )回上層 (h)說明';
    return rows;
  }

  private listRows(): string[] {
    const rows = Array(24).fill('');
    rows[0] = `【板主:tester】    [測試] Fake board                ${this.searching ? '系列' : '看板'}《${this.currentBoard}》`;
    rows[1] = '[→ ]閱讀 [z]精華區 [Tab]文摘 [s]選擇看板 [b]進板 [i]看板設定';
    rows[2] = '   編號    日 期 作  者       文  章  標  題                            人氣:1';
    for (let i = 0; i < WINDOW; i++) {
      const a = this.items[this.top + i];
      if (!a) continue;
      const cursor = this.top + i === this.cursor ? '>' : ' ';
      const numberField = a.pinned ? '   ★  ' : String(this.numberOf(a)).padStart(6);
      const type = a.kind === 'reply' ? 'R:' : '□ ';
      const title = a.kind === 'deleted' ? '(本文已被刪除) [x]' : a.title;
      const author = a.kind === 'deleted' ? '-' : a.author;
      rows[3 + i] =
        `${cursor}${numberField} ${a.mark ?? ' '}${(a.push ?? '').padStart(2)}${(a.date ?? '11/01').padStart(5)} ` +
        `${author.padEnd(12)} ${type} ${title}`;
    }
    rows[23] = ` ${this.searching ? '系列文章' : '文章列表'}  (^P)發表 (y)回應 (X)推文 (d)刪除 (→ )閱讀 (b)進板  (← )離開 (h)說明`;
    return rows;
  }

  private articleRows(): string[] {
    const { total, pages, starts } = this.pageInfo();
    const page = starts.indexOf(this.articleStart);
    const from = this.articleStart === 0 ? 1 : this.articleStart;
    const to = this.articleStart + 22;
    const percent = page === pages - 1 ? 100 : Math.floor((to / total) * 100);
    const rows = Array.from(
      { length: 23 },
      (_, i) => this.articleLines[this.articleStart + i] ?? ''
    );
    rows.push(
      `  瀏覽 第 ${page + 1}/${pages} 頁 (${String(percent).padStart(3)}%)  目前顯示: 第 ${String(from).padStart(2, '0')}~${to} 行 (y)回應(X)推文  (← )離開(h)說明`
    );
    return rows;
  }
}
