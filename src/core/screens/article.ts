import { UnexpectedScreenError } from '../errors';
import type { Push } from '../models';
import type { Lines } from './prompts';

export interface ArticleStatus {
  page: number;
  /** 0 when the screen does not say. */
  pages: number;
  percent: number;
  /** "目前顯示: 第 from~to 行" */
  from: number;
  to: number;
}

export interface ArticlePage {
  /** The 23 content rows (screen rows 0..22). */
  rows: string[];
  status: ArticleStatus;
}

export interface ArticleHeader {
  author: string;
  board?: string;
  title: string;
  time: string;
}

export interface ParsedArticle {
  header: ArticleHeader | null;
  bodyLines: string[];
  pushes: Push[];
  /** From the "※ 文章網址" line in the body. */
  url?: string;
}

// Long or still-growing articles show "第 1 頁" without the total, so "/N" is optional.
const STATUS =
  /瀏覽\s+第\s*(\d+)(?:\/(\d+))?\s*頁\s*\(\s*(\d+)%\)\s*目前顯示:\s*第\s*(\d+)~(\d+)\s*行/;

export function parseArticleStatus(lines: Lines): ArticleStatus | null {
  const m = STATUS.exec(lines[23] ?? '');
  return m
    ? {
        page: Number(m[1]),
        pages: m[2] ? Number(m[2]) : 0,
        percent: Number(m[3]),
        from: Number(m[4]),
        to: Number(m[5]),
      }
    : null;
}

export function parseArticlePage(lines: Lines): ArticlePage | null {
  const status = parseArticleStatus(lines);
  return status ? { rows: Array.from({ length: 23 }, (_, i) => lines[i] ?? ''), status } : null;
}

/**
 * Joins consecutive pages. Paging by PgDn leaves rows repeated at the break: one row between full pages, and
 * more on the last page, which is anchored to the end. The status numbers count source lines, not screen rows,
 * so they only predict the overlap for articles without wrapped lines (verified live: it is `previous.to -
 * current.from + 1`, or one more on a short article's last page). When the prediction does not hold the overlap
 * is found from the rows themselves: the longest run of rows that ends the text so far and starts the new page.
 * Pages sharing no row at all do not belong together.
 */
export function mergePages(pages: ArticlePage[]): string[] {
  if (pages.length === 0) {
    return [];
  }
  const merged = [...pages[0]!.rows];
  for (let i = 1; i < pages.length; i++) {
    const prev = pages[i - 1]!;
    const cur = pages[i]!;
    const expected = prev.status.to - cur.status.from + 1;
    let overlap = [expected, expected + 1].find((n) => n >= 1 && repeats(merged, cur.rows, n));
    for (let n = Math.min(cur.rows.length, merged.length); overlap === undefined && n >= 1; n--) {
      overlap = repeats(merged, cur.rows, n) ? n : undefined;
    }
    if (overlap === undefined) {
      throw new UnexpectedScreenError(
        `Article pages do not line up (page ${i + 1}, expected overlap ${expected})`,
        cur.rows
      );
    }
    merged.push(...cur.rows.slice(overlap));
  }
  return merged;
}

/** True when the last `n` rows of `merged` are the first `n` rows of `next`. */
function repeats(merged: string[], next: string[], n: number): boolean {
  return (
    n >= 0 &&
    n <= next.length &&
    n <= merged.length &&
    merged.slice(merged.length - n).join('\n') === next.slice(0, n).join('\n')
  );
}

// Some articles pad the id to 12 columns before the colon ("噓 yuijen      : ..."), others do not.
const PUSH = /^(推|噓|→)\s*(\S+?)\s*:\s*(.*?)\s+(\d{2}\/\d{2})(?:\s+(\d{2}:\d{2}))?\s*$/;
const SIGNATURE = /^※\s*(發信站|文章網址)/;
const TRANSFER_LINE = /^※\s*轉錄者:/;
const URL_LINE = /^※\s*文章網址:\s*(https?:\/\/\S+)/;

export function parseArticle(rows: readonly string[]): ParsedArticle {
  const header = parseHeader(rows);
  // Header takes rows 0-2 and a separator on row 3.
  const start = header ? (/^[─\s]+$/.test(rows[3] ?? '') ? 4 : 3) : 0;
  const content = rows.slice(start);
  while (content.length > 0 && content[content.length - 1]!.trim() === '') {
    content.pop();
  }

  let lastSignature = -1;
  content.forEach((l, i) => {
    if (SIGNATURE.test(l)) {
      lastSignature = i;
    }
  });
  let pushStart = content.length;
  if (lastSignature >= 0) {
    const first = content.findIndex((l, i) => i > lastSignature && PUSH.test(l));
    if (first >= 0) {
      pushStart = first;
    }
  }

  const pushes: Push[] = [];
  for (const line of content.slice(pushStart)) {
    const m = PUSH.exec(line);
    if (m) {
      pushes.push({
        kind: m[1] as Push['kind'],
        userId: m[2]!,
        content: m[3]!,
        date: m[4]!,
        time: m[5],
      });
    }
  }

  const bodyLines = content.slice(0, pushStart);
  // The BBS appends its own "※ 文章網址" line after the author's text, so the last one is authoritative;
  // earlier ones can be quoted from another article.
  let url: string | undefined;
  for (const line of bodyLines) {
    url = URL_LINE.exec(line)?.[1] ?? url;
    // A cross-posted copy carries the original's signature and then its own, which has no URL ("轉錄者").
    // Seen live: the only URL in the text is the original's, so it says nothing about this article.
    if (TRANSFER_LINE.test(line)) {
      url = undefined;
    }
  }
  return { header, bodyLines, pushes, url };
}

function parseHeader(rows: readonly string[]): ArticleHeader | null {
  const author = /^\s*作者\s+(.+?)(?:\s{2,}看板\s+(\S+))?\s*$/.exec(rows[0] ?? '');
  if (!author) {
    return null;
  }
  const title = /^\s*標題\s+(.*?)\s*$/.exec(rows[1] ?? '');
  const time = /^\s*時間\s+(.*?)\s*$/.exec(rows[2] ?? '');
  return {
    author: author[1]!,
    board: author[2],
    title: title?.[1] ?? '',
    time: time?.[1] ?? '',
  };
}
