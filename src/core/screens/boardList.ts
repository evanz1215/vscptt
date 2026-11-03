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

const BOARD_NAME = /看板《([^》]+)》/;

export function isBoardList(lines: Lines): boolean {
  return BOARD_NAME.test(lines[0] ?? '') && (lines[23] ?? '').trimStart().startsWith('文章列表');
}

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

export function parseBoardList(lines: Lines): BoardListScreen | null {
  if (!isBoardList(lines)) {
    return null;
  }
  const board = BOARD_NAME.exec(lines[0]!)![1]!;
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
