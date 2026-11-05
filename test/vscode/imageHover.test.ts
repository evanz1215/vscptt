import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { ImageHoverProvider } from '../../src/vscode/imageHover';

const doc = (text: string) => ({ lineAt: () => ({ text }) }) as unknown as vscode.TextDocument;
const at = (character: number) => new vscode.Position(0, character);
const text = (hover: vscode.Hover | undefined) =>
  (hover?.contents as unknown as { value: string } | undefined)?.value;

describe('image hover', () => {
  const line = '推 user: https://imgur.com/abc123 好讚';
  const provider = new ImageHoverProvider(() => true);

  it('shows the picture while the mouse is on the link', () => {
    const hover = provider.provideHover(doc(line), at(15));
    expect(text(hover)).toBe('![](https://i.imgur.com/abc123.jpg)');
    const link = 'https://imgur.com/abc123';
    const start = line.indexOf(link);
    expect(hover?.range).toMatchObject({
      startCharacter: start,
      endCharacter: start + link.length,
    });
  });

  it('shows nothing beside the link or on a link that is not an image', () => {
    expect(provider.provideHover(doc(line), at(2))).toBeUndefined();
    expect(provider.provideHover(doc(line), at(line.indexOf(' 好讚')))).toBeUndefined();
    expect(
      provider.provideHover(doc('https://www.ptt.cc/bbs/Soft_Job/M.1.A.B.html'), at(10))
    ).toBeUndefined();
  });

  it('shows nothing when previews are turned off', () => {
    expect(new ImageHoverProvider(() => false).provideHover(doc(line), at(15))).toBeUndefined();
  });

  it('keeps parentheses from ending the Markdown link early', () => {
    const hover = provider.provideHover(doc('https://a.com/x(1).png'), at(5));
    expect(text(hover)).toBe('![](https://a.com/x%281%29.png)');
  });
});
