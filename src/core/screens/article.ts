import { UnexpectedScreenError } from '../errors';
import type { Push } from '../models';
import type { Lines } from './prompts';

export interface ArticleStatus {
  page: number;
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

const STATUS = /瀏覽\s+第\s*(\d+)\/(\d+)\s*頁\s*\(\s*(\d+)%\)\s*目前顯示:\s*第\s*(\d+)~(\d+)\s*行/;

export function parseArticleStatus(lines: Lines): ArticleStatus | null {
  const m = STATUS.exec(lines[23] ?? '');
  return m
    ? {
        page: Number(m[1]),
        pages: Number(m[2]),
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
 * Joins consecutive pages. Verified on the live server: the rows that repeat at a page break number
 * `previous.to - current.from + 1` (1 between middle pages, more on the last page, which is anchored to the end).
 * The repeated rows must be identical, otherwise the pages do not belong together.
 */
export function mergePages(pages: ArticlePage[]): string[] {
  if (pages.length === 0) {
    return [];
  }
  const merged = [...pages[0]!.rows];
  for (let i = 1; i < pages.length; i++) {
    const prev = pages[i - 1]!;
    const cur = pages[i]!;
    const overlap = prev.status.to - cur.status.from + 1;
    const tail = merged.slice(merged.length - Math.max(overlap, 0));
    const head = cur.rows.slice(0, Math.max(overlap, 0));
    if (
      overlap < 0 ||
      overlap > cur.rows.length ||
      overlap > merged.length ||
      tail.join('\n') !== head.join('\n')
    ) {
      throw new UnexpectedScreenError(
        `Article pages do not line up (page ${cur.status.page}, overlap ${overlap})`,
        cur.rows
      );
    }
    merged.push(...cur.rows.slice(overlap));
  }
  return merged;
}

const PUSH = /^(推|噓|→)\s*(\S+?):\s*(.*?)\s+(\d{2}\/\d{2})(?:\s+(\d{2}:\d{2}))?\s*$/;
const SIGNATURE = /^※\s*(發信站|文章網址)/;
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
