import { describe, expect, it } from 'vitest';
import { isPttArticleUrl } from '../../src/vscode/commands';

describe('which address may be opened in the browser', () => {
  it('accepts an article page', () => {
    expect(isPttArticleUrl('https://www.ptt.cc/bbs/Soft_Job/M.1793499440.A.938.html')).toBe(true);
    expect(isPttArticleUrl('https://www.ptt.cc/bbs/C-Chat/M.1.A.0aF.html')).toBe(true);
  });

  it.each([
    ['another site', 'https://evil.example/bbs/Dev/M.1.A.938.html'],
    ['a look-alike host', 'https://www.ptt.cc.evil.example/bbs/Dev/M.1.A.938.html'],
    ['plain http', 'http://www.ptt.cc/bbs/Dev/M.1.A.938.html'],
    ['a user name in front of the host', 'https://www.ptt.cc@evil.example/bbs/Dev/M.1.A.938.html'],
    ['extra path after the page', 'https://www.ptt.cc/bbs/Dev/M.1.A.938.html/../x'],
    ['a query string', 'https://www.ptt.cc/bbs/Dev/M.1.A.938.html?x=1'],
    ['a line break at the end', 'https://www.ptt.cc/bbs/Dev/M.1.A.938.html\n'],
    ['a script address', 'javascript:alert(1)'],
    ['nothing', ''],
  ])('refuses %s', (_name, url) => {
    expect(isPttArticleUrl(url)).toBe(false);
  });
});
