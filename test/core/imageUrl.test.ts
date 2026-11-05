import { describe, expect, it } from 'vitest';
import { imagePreviewUrl, urlsInLine } from '../../src/core/imageUrl';

describe('imagePreviewUrl', () => {
  it.each([
    ['https://i.imgur.com/abc123.jpg', 'https://i.imgur.com/abc123.jpg'],
    ['http://i.imgur.com/abc123.png', 'https://i.imgur.com/abc123.png'],
    ['https://imgur.com/abc123', 'https://i.imgur.com/abc123.jpg'],
    ['https://imgur.com/i/abc123', 'https://i.imgur.com/abc123.jpg'],
    ['https://imgur.com/abc123.gifv', 'https://i.imgur.com/abc123.gif'],
    [
      'https://gyazo.com/0123456789abcdef0123456789abcdef',
      'https://i.gyazo.com/0123456789abcdef0123456789abcdef.png',
    ],
    ['http://example.com/pics/cat.JPG', 'https://example.com/pics/cat.JPG'],
    ['https://example.com/a.webp?x=1', 'https://example.com/a.webp?x=1'],
  ])('previews %s', (input, expected) => {
    // the query-string case: only the path decides, the query is kept
    expect(imagePreviewUrl(input)).toBe(expected);
  });

  it.each([
    ['an imgur album', 'https://imgur.com/a/AbCdE'],
    ['an imgur page', 'https://imgur.com/gallery'],
    ['a reserved imgur path', 'https://imgur.com/upload'],
    ['a gyazo link with a short id', 'https://gyazo.com/abc'],
    ['an ordinary web page', 'https://www.ptt.cc/bbs/Soft_Job/M.1.A.B.html'],
    ['an svg', 'https://example.com/a.svg'],
    ['a link with a password in it', 'https://user:pw@example.com/a.png'],
    ['another scheme', 'ftp://example.com/a.png'],
    ['a script URL', 'javascript:alert(1)//a.png'],
    ['something that is not a URL', 'not a url'],
  ])('does not preview %s', (_name, input) => {
    expect(imagePreviewUrl(input)).toBeNull();
  });
});

describe('urlsInLine', () => {
  it('finds addresses and their positions', () => {
    const line = '推 user: https://i.imgur.com/a.jpg 好讚';
    const url = 'https://i.imgur.com/a.jpg';
    const start = line.indexOf(url);
    expect(urlsInLine(line)).toEqual([{ url, start, end: start + url.length }]);
  });

  it('stops at Chinese text and punctuation, and at quotes and brackets', () => {
    expect(urlsInLine('看https://a.com/x.png，很讚')[0]!.url).toBe('https://a.com/x.png');
    expect(urlsInLine('(https://a.com/x.png)')[0]!.url).toBe('https://a.com/x.png');
    expect(urlsInLine('<https://a.com/x.png>')[0]!.url).toBe('https://a.com/x.png');
    expect(urlsInLine('"https://a.com/x.png"')[0]!.url).toBe('https://a.com/x.png');
  });

  it('finds several, and ignores a bare scheme', () => {
    expect(urlsInLine('https://a.com/1.png http://b.com/2.png').map((s) => s.url)).toEqual([
      'https://a.com/1.png',
      'http://b.com/2.png',
    ]);
    expect(urlsInLine('see https:// here')).toEqual([]);
  });
});
