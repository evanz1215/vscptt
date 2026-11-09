import { InvalidArgumentError } from './errors';
import type { SearchQuery } from './models';

/** What to type into PTT: the key that opens the prompt, then the text to answer it with. */
export interface SearchInput {
  key: '/' | 'a' | 'Z';
  text: string;
}

/**
 * C0 and C1 control characters (ESC, CR, DEL, ...), plus invisible formatting characters (direction overrides,
 * zero-width marks, line and paragraph separators) that could make a label or a prompt misleading.
 */
const hasControl = (text: string): boolean =>
  [...text].some((ch) => {
    const code = ch.codePointAt(0)!;
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      /\p{Cf}/u.test(ch)
    );
  });
const AUTHOR = /^[A-Za-z0-9_]{1,12}$/;
export const MAX_TITLE_LENGTH = 30;
/** PTT's prompt buffer is counted in bytes, not characters; stay well under what a short prompt can take. */
export const MAX_TITLE_BYTES = 60;
export const MAX_PUSH_THRESHOLD = 100;

/**
 * Checks a query before anything is typed. The text goes straight into a BBS prompt, so control characters
 * (which could cancel or confirm it early) are refused, and the author and push forms are held to what PTT
 * accepts there.
 */
export function toSearchInput(query: SearchQuery): SearchInput {
  switch (query?.kind) {
    case 'title': {
      const text = typeof query.text === 'string' ? query.text.trim() : '';
      if (
        text === '' ||
        [...text].length > MAX_TITLE_LENGTH ||
        Buffer.byteLength(text) > MAX_TITLE_BYTES ||
        hasControl(text)
      ) {
        throw new InvalidArgumentError(
          `A title search needs 1 to ${MAX_TITLE_LENGTH} printable characters (at most ${MAX_TITLE_BYTES} bytes)`
        );
      }
      return { key: '/', text };
    }
    case 'author': {
      if (typeof query.text !== 'string' || !AUTHOR.test(query.text)) {
        throw new InvalidArgumentError(
          'An author search needs 1 to 12 letters, digits or underscores'
        );
      }
      return { key: 'a', text: query.text };
    }
    case 'push': {
      const n = query.threshold;
      if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_PUSH_THRESHOLD) {
        throw new InvalidArgumentError(
          `A push search needs a whole number from -${MAX_PUSH_THRESHOLD} to ${MAX_PUSH_THRESHOLD}`
        );
      }
      return { key: 'Z', text: String(n) };
    }
    default:
      throw new InvalidArgumentError('Unknown search type');
  }
}

/** The query in its one canonical form (trimmed, no extra fields), so equal searches look equal. */
export function normalizeSearch(query: SearchQuery): SearchQuery {
  const input = toSearchInput(query);
  return query.kind === 'push'
    ? { kind: 'push', threshold: query.threshold }
    : { kind: query.kind, text: input.text };
}

/**
 * The title search for the thread an article belongs to: its title without "Re:" / "Fw:", cut to what the
 * prompt takes (a title search matches any part, so a cut title still finds the thread). Undefined when
 * nothing searchable is left.
 */
export function threadQuery(title: string): SearchQuery | undefined {
  const text = title.replace(/^\s*(?:(?:re|fw)\s*:\s*)+/i, '').trim();
  let out = '';
  for (const ch of text) {
    if ([...out].length >= MAX_TITLE_LENGTH || Buffer.byteLength(out + ch) > MAX_TITLE_BYTES) {
      break;
    }
    out += ch;
  }
  try {
    return normalizeSearch({ kind: 'title', text: out });
  } catch {
    return undefined;
  }
}

/** A short label, e.g. for a tree node. */
export function describeSearch(query: SearchQuery): string {
  switch (query.kind) {
    case 'title':
      return `標題「${query.text}」`;
    case 'author':
      return `作者 ${query.text}`;
    case 'push':
      return query.threshold < 0
        ? `噓文數超過 ${-query.threshold}`
        : `推文數超過 ${query.threshold}`;
  }
}
