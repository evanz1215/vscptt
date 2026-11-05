import * as vscode from 'vscode';
import { imagePreviewUrl, urlsInLine } from '../core/imageUrl';

/**
 * Shows the picture when the mouse rests on an image link in an article. The picture is fetched by VS Code from
 * the image's own server, so that server learns the reader's address; the setting `vscptt.preview.images` turns
 * it off.
 */
export class ImageHoverProvider implements vscode.HoverProvider {
  constructor(private readonly enabled: () => boolean) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!this.enabled()) {
      return undefined;
    }
    const span = urlsInLine(document.lineAt(position.line).text).find(
      (s) => position.character >= s.start && position.character < s.end
    );
    const image = span && imagePreviewUrl(span.url);
    if (!span || !image) {
      return undefined;
    }
    // Parentheses would end the Markdown link early; everything else URL.href has already escaped.
    const safe = image.replace(/\(/g, '%28').replace(/\)/g, '%29');
    const range = new vscode.Range(position.line, span.start, position.line, span.end);
    return new vscode.Hover(new vscode.MarkdownString(`![](${safe})`), range);
  }
}
