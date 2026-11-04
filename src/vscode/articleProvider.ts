import * as vscode from 'vscode';
import type { Article, ArticleRef } from '../core/models';
import { renderArticle, renderArticleError } from './articleText';
import { describeError } from './errorMessages';

export const ARTICLE_SCHEME = 'vscptt';

/** What the content provider reads articles through. PttService satisfies it. */
export interface ArticleSource {
  getArticle(ref: ArticleRef): Promise<Article>;
  invalidate(board?: string, id?: string): void;
}

/** The tab shows the path, so make it readable and keep it a single safe path segment. */
function tabName(title: string): string {
  const cleaned = Array.from(title)
    .filter((ch) => ch.charCodeAt(0) >= 32 && !'/\\?#%:*"<>|'.includes(ch))
    .join('')
    .trim();
  return (cleaned.slice(0, 50) || 'article') + '.txt';
}

/**
 * The address of an article document. The reference travels in the query as base64url: it uses only letters,
 * digits, '-' and '_', so VS Code's URI encoding and decoding (which runs again when a tab is restored) cannot
 * change it, whatever the title contains.
 */
export function articleUri(ref: ArticleRef, title: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: ARTICLE_SCHEME,
    path: `/${ref.board}/${tabName(title)}`,
    query: Buffer.from(JSON.stringify(ref), 'utf8').toString('base64url'),
  });
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number';

/**
 * Reads the reference back out of an address. Anything that is not exactly the shape articleUri writes is
 * rejected: other extensions or restored sessions can hand us any address.
 */
export function refFromUri(uri: vscode.Uri): ArticleRef | undefined {
  if (uri.scheme !== ARTICLE_SCHEME) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(uri.query, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (!isString(r.board)) {
    return undefined;
  }
  const optional = (key: string, ok: (v: unknown) => boolean) => r[key] === undefined || ok(r[key]);
  if (
    !optional('listNumber', isNumber) ||
    !optional('pinnedIndex', isNumber) ||
    !optional('isPinned', (v) => typeof v === 'boolean') ||
    !optional('title', isString) ||
    !optional('id', isString)
  ) {
    return undefined;
  }
  return {
    board: r.board,
    listNumber: r.listNumber as number | undefined,
    pinnedIndex: r.pinnedIndex as number | undefined,
    isPinned: r.isPinned as boolean | undefined,
    title: r.title as string | undefined,
    id: r.id as string | undefined,
  };
}

/** Provides the text of article documents. A failure becomes the document's text, so a tab is never blank. */
export class ArticleContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly source: () => ArticleSource,
    private readonly onError: (message: string) => void = () => {}
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = refFromUri(uri);
    if (!ref) {
      return renderArticleError('這個網址不是 vscptt 產生的文章位址。');
    }
    try {
      return renderArticle(await this.source().getArticle(ref));
    } catch (error) {
      const message = describeError(error);
      this.onError(message);
      return renderArticleError(message);
    }
  }

  /** Forget the cached copy of the article behind `uri` and make the editor read it again. */
  refresh(uri: vscode.Uri): void {
    const ref = refFromUri(uri);
    if (ref) {
      try {
        this.source().invalidate(ref.board);
      } catch {
        // not connected: nothing cached
      }
    }
    this.changed.fire(uri);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
