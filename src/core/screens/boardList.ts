import type { ArticleKind } from '../models';
import type { Lines } from './prompts';

export interface ListRow {
  /** Screen row, 3..22. */
  screenRow: number;
  /** The `>` cursor is on this row. */
  selected: boolean;
  /** Absent for pinned rows (they show ★ instead). */
  number?: number;
  isPinned: boolean;
  mark: string;
  push: string;
  date: string;
  author: string;
  kind: ArticleKind;
  title: string;
}

export interface BoardListScreen {
  board: string;
  rows: ListRow[];
  selected?: ListRow;
}

/**
 * The same list screen in two modes. After a search PTT shows only the matches ("系列" = series): the header says
 * 系列《board》, the footer 系列文章, the rows are numbered 1..N within the results, and there are no pinned rows.
 * Verified on the live server, 2026-11-04.
 */
export type ListMode = 'normal' | 'search';

// When the moderators and the board banner do not fit, PTT shortens the name to `【板主:…】[LoL] banner`
// (seen live on LoL, 2026-11-09); the footer still tells the two modes apart.
const SHORT = /】\[([\w-]+)\]/;
const HEADER: Record<ListMode, RegExp> = {
  normal: /看板《([^》]+)》/,
  search: /系列《([^》]+)》/,
};
const boardIn = (line: string, mode: ListMode): string | undefined =>
  (HEADER[mode].exec(line) ?? SHORT.exec(line))?.[1];
const FOOTER: Record<ListMode, string> = { normal: '文章列表', search: '系列文章' };

export function isBoardList(lines: Lines, mode: ListMode = 'normal'): boolean {
  return (
    boardIn(lines[0] ?? '', mode) !== undefined &&
    (lines[23] ?? '').trimStart().startsWith(FOOTER[mode])
  );
}

export const isSearchList = (lines: Lines): boolean => isBoardList(lines, 'search');

export const sameBoard = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Fixed columns (verified on the live board list, 2026-11-03): cursor 0, number 1-6 (★ for pinned), mark 8,
 * push 9-10, date 11-15, author 17-28, type 30-31, title 33. Everything before the title is ASCII, so string
 * indexes equal screen columns here.
 */
function parseRow(line: string, screenRow: number): ListRow | null {
  const numberField = line.slice(1, 7);
  const isPinned = numberField.includes('★');
  const digits = /^\s*(\d+)\s*$/.exec(numberField);
  if (!isPinned && !digits) {
    return null;
  }

  const type = line.slice(30, 32).trim();
  const title = line.slice(32).trim();
  const author = line.slice(17, 29).trim();
  const kind: ArticleKind =
    title.startsWith('(本文已被刪除)') || author === '-'
      ? 'deleted'
      : type === 'R:'
        ? 'reply'
        : type === '□'
          ? 'normal'
          : 'other';

  return {
    screenRow,
    selected: line.startsWith('>'),
    number: isPinned ? undefined : Number(digits![1]),
    isPinned,
    mark: line.slice(8, 9).trim(),
    push: line.slice(9, 11).trim(),
    date: line.slice(11, 16).trim(),
    author,
    kind,
    title,
  };
}

export function parseBoardList(lines: Lines, mode: ListMode = 'normal'): BoardListScreen | null {
  if (!isBoardList(lines, mode)) {
    return null;
  }
  const board = boardIn(lines[0]!, mode)!;
  const rows: ListRow[] = [];
  for (let r = 3; r <= 22; r++) {
    const line = lines[r] ?? '';
    if (line.trim() === '') {
      continue;
    }
    const row = parseRow(line, r);
    if (row) {
      rows.push(row);
    }
  }
  return { board, rows, selected: rows.find((r) => r.selected) };
}
