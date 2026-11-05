import type { ArticleId } from './models';

/** PTT's AID alphabet: 6 bits per character, most significant first (checked against live `Q` boxes). */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
const ID = /^M\.(\d{1,10})\.A\.([0-9A-Fa-f]{3})$/;
const AID = /^#?([0-9A-Za-z_-]{8})$/;
const BOARD = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$/;
const URL = /^https?:\/\/www\.ptt\.cc\/bbs\/([^/]+)\/(M\.\d+\.A\.[0-9A-Fa-f]{3})\.html$/;

/** "M.1793499440.A.938" -> "#1gvg4mau". Undefined for ids that are not ordinary articles. */
export function aidFromId(id: ArticleId): string | undefined {
  const m = ID.exec(id);
  if (!m || Number(m[1]) > 0xffffffff) {
    return undefined;
  }
  let n = (BigInt(m[1]!) << 12n) | BigInt(parseInt(m[2]!, 16));
  let out = '';
  for (let i = 0; i < 8; i++) {
    out = ALPHABET[Number(n & 63n)] + out;
    n >>= 6n;
  }
  return `#${out}`;
}

/** "#1gvg4mau" -> "M.1793499440.A.938". Undefined for anything that is not an ordinary article's code. */
export function idFromAid(aid: string): ArticleId | undefined {
  const m = AID.exec(aid);
  if (!m) {
    return undefined;
  }
  let n = 0n;
  for (const ch of m[1]!) {
    n = (n << 6n) | BigInt(ALPHABET.indexOf(ch));
  }
  if (n >> 44n !== 0n) {
    return undefined; // a type other than "M" (e.g. "G" files)
  }
  const hex = (n & 0xfffn).toString(16).toUpperCase().padStart(3, '0');
  return `M.${n >> 12n}.A.${hex}`;
}

export interface ArticleAddress {
  /** Missing when only a bare code was given. */
  board?: string;
  id: ArticleId;
}

/**
 * What a user pastes to open an article: an article URL, "#AID (Board)" as PTT prints it, or a bare "#AID".
 * Undefined for anything else, so nothing unchecked is ever typed into PTT.
 */
export function parseArticleAddress(text: string): ArticleAddress | undefined {
  const input = text.trim();
  const url = URL.exec(input);
  if (url) {
    return BOARD.test(url[1]!) ? { board: url[1]!, id: url[2]! } : undefined;
  }
  const m = /^(#?[0-9A-Za-z_-]{8})(?:\s*\(([^)]+)\))?$/.exec(input);
  const id = m && idFromAid(m[1]!);
  if (!id) {
    return undefined;
  }
  if (m[2] === undefined) {
    return { id };
  }
  return BOARD.test(m[2]) ? { board: m[2], id } : undefined;
}
