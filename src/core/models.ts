/** The file name part of an article URL, e.g. "M.1793499440.A.938". Stable, unlike the list number. */
export type ArticleId = string;

export type ArticleKind = 'normal' | 'reply' | 'deleted' | 'other';

export interface ArticleSummary {
  board: string;
  /** Number shown in the list. Changes when articles are removed; pinned articles have none. */
  listNumber?: number;
  /** Position among the pinned rows of the latest page (0-based). */
  pinnedIndex?: number;
  isPinned: boolean;
  title: string;
  author: string;
  /** "MM/DD" exactly as shown; the list has no year. */
  date: string;
  /** As shown: "", "9", "爆", "X1"... */
  push: string;
  mark: string;
  kind: ArticleKind;
}

export interface PageCursor {
  /** Return articles whose list number is below this one. */
  before: number;
}

export interface BoardPage {
  board: string;
  /** Newest first. */
  articles: ArticleSummary[];
  /** Only filled on the latest page. */
  pinned: ArticleSummary[];
  hasOlder: boolean;
  /** Pass to getBoardPage for the next (older) page. */
  next?: PageCursor;
}

export interface Push {
  kind: '推' | '噓' | '→';
  userId: string;
  content: string;
  /** "MM/DD" */
  date: string;
  /** "HH:mm", absent on old articles. */
  time?: string;
}

export interface Article {
  board: string;
  id?: ArticleId;
  aid?: string;
  url?: string;
  title: string;
  author: string;
  time: string;
  bodyLines: string[];
  pushes: Push[];
  /** True when the content was checked against the article the list pointed at (see docs/plan.md 5.5). */
  verified: boolean;
  /** A pinned entry whose body carries a different article URL than the entry itself (an edited copy). */
  pinnedMirror: boolean;
  /** The article was longer than the page limit; only the first pages were read. */
  truncated: boolean;
}

export interface FavoriteEntry {
  name: string;
  category: string;
  title: string;
  unread: boolean;
}

/** How to find an article in a board list. */
export interface ArticleRef {
  board: string;
  listNumber?: number;
  isPinned?: boolean;
  pinnedIndex?: number;
  /** The list title; used to notice that the list changed underneath us. */
  title?: string;
  /** Known id (from an earlier resolve); the article opened must have exactly this id. */
  id?: ArticleId;
}

export interface ResolvedArticle {
  board: string;
  id: ArticleId;
  aid: string;
  url: string;
}
