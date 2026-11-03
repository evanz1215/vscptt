import type { ArticleId } from '../models';
import type { Lines } from './prompts';

export interface AidPopup {
  /** "#1gvg4mau" */
  aid: string;
  board: string;
  url: string;
  id: ArticleId;
}

const AID = /文章代碼\(AID\):\s*(#\S+)\s*\(([^)]+)\)/;
const URL_LINE = /文章網址:\s*(https?:\/\/\S+)/;

/** The box that `Q` draws over the list. Its position varies, so scan every row. */
export function parseAidPopup(lines: Lines): AidPopup | null {
  const text = lines.join('\n');
  const aid = AID.exec(text);
  const url = URL_LINE.exec(text);
  if (!aid || !url) {
    return null;
  }
  const id = idFromUrl(url[1]!);
  return id ? { aid: aid[1]!, board: aid[2]!, url: url[1]!, id } : null;
}

export function idFromUrl(url: string): ArticleId | undefined {
  return /\/([^/]+)\.html$/.exec(url)?.[1];
}
