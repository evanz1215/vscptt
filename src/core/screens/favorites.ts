import type { Lines } from './prompts';

export interface FavoriteRow {
  screenRow: number;
  selected: boolean;
  number: number;
  /** A folder or a separator line also takes a number, so it counts when deciding whether a page is full. */
  kind: 'board' | 'folder' | 'line';
  name: string;
  category: string;
  /** Description plus popularity and moderators, as shown. */
  title: string;
  unread: boolean;
}

export function isFavoritesScreen(lines: Lines): boolean {
  return (lines[0] ?? '').startsWith('【看板列表】') && (lines[23] ?? '').includes('我的最愛');
}

/**
 * The hot boards use the same list screen; its footer caption is 看板列表 instead of 我的最愛
 * (mbbsd/board.c brdlist_caption). Rows are read with parseFavorites.
 */
export function isHotBoardsScreen(lines: Lines): boolean {
  return (
    (lines[0] ?? '').startsWith('【看板列表】') &&
    (lines[23] ?? '').trimStart().startsWith('看板列表')
  );
}

// `>     1 ˇ LoL          遊戲 ◎ [LoL] 八強賽 DK BLG    HOTsamhou6/co…`
// The category is double-width, so columns after it do not line up with string indexes; use a pattern.
const ROW = /^([> ])\s*(\d+)\s+(ˇ\s+)?(\S+)\s+(\S+)\s+◎\s*(.*?)\s*$/;

// pttbbs (mbbsd/board.c) draws a folder as `MyFavFolder  目錄 ◎<title>` and a separator as a run of dashes.
const FOLDER_NAME = 'MyFavFolder';
const FOLDER_CLASS = '目錄';
const LINE = /^([> ])\s*(\d+)\s+(?:D\s+)?-{12}\s+-{12,}\s*$/;

/** The number of the row the cursor is on, if it is on a row we recognise. */
export function selectedNumber(lines: Lines): number | undefined {
  return parseFavorites(lines).find((r) => r.selected)?.number;
}

/** Boards, folders and separator lines, in screen order. Only the boards can be entered. */
export function parseFavorites(lines: Lines): FavoriteRow[] {
  const rows: FavoriteRow[] = [];
  for (let r = 3; r <= 22; r++) {
    const text = lines[r] ?? '';
    const m = ROW.exec(text);
    if (m) {
      const folder = m[4] === FOLDER_NAME && m[5] === FOLDER_CLASS;
      rows.push({
        screenRow: r,
        selected: m[1] === '>',
        number: Number(m[2]),
        kind: folder ? 'folder' : 'board',
        unread: m[3] !== undefined,
        name: m[4]!,
        category: m[5]!,
        title: m[6]!,
      });
      continue;
    }
    const line = LINE.exec(text);
    if (line) {
      rows.push({
        screenRow: r,
        selected: line[1] === '>',
        number: Number(line[2]),
        kind: 'line',
        unread: false,
        name: '',
        category: '',
        title: '',
      });
    }
  }
  return rows;
}
