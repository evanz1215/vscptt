import type { Article, Push } from '../core/models';

const RULE = '──────────────────────────────';

function pushLine(p: Push): string {
  const when = p.time ? `${p.date} ${p.time}` : p.date;
  return `${p.kind} ${p.userId}: ${p.content}    ${when}`;
}

/** "推 3・噓 1・→ 2（共 6 則）" */
function pushStats(pushes: Push[]): string {
  const n = (kind: Push['kind']) => pushes.filter((p) => p.kind === kind).length;
  return `推 ${n('推')}・噓 ${n('噓')}・→ ${n('→')}（共 ${pushes.length} 則）`;
}

/** The text of the read-only document an article is shown in (docs/plan.md 6.3). The pushes are always its last lines. */
export function renderArticle(article: Article): string {
  const notices: string[] = [];
  if (article.pinnedMirror) {
    notices.push('※ 這是置頂文，內容來自另一篇文章（文章網址與清單項目不同）。');
  }
  if (!article.verified) {
    notices.push('※ 無法把這篇文章的內容和清單項目核對（缺少文章網址），僅供參考。');
  }
  if (article.truncated) {
    notices.push('※ 文章很長，只顯示前面的部分。');
  }

  const lines = [
    `標題：${article.title}`,
    `作者：${article.author}`,
    `看板：${article.board}`,
    `時間：${article.time}`,
    `網址：${article.url ?? ''}`,
    ...(article.pushes.length > 0 ? [`推文：${pushStats(article.pushes)}`] : []),
    ...notices,
    RULE,
    ...article.bodyLines,
  ];
  if (article.pushes.length > 0) {
    lines.push(RULE, ...article.pushes.map(pushLine));
  }
  return `${lines.join('\n')}\n`;
}

/** What an article tab shows when the article could not be read, so the tab is never blank. */
export function renderArticleError(message: string): string {
  return `無法開啟這篇文章\n\n${message}\n\n可以回到「PTT」檢視，重新整理該看板後再試一次。\n`;
}
