import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Article } from '../../src/core/models';
import { renderArticle } from '../../src/vscode/articleText';

interface Rule {
  match?: string;
  name?: string;
  captures?: Record<string, { name?: string }>;
  patterns?: Array<{ include?: string } & Rule>;
}
const grammar = JSON.parse(readFileSync('syntaxes/ptt.tmLanguage.json', 'utf8')) as {
  scopeName: string;
  patterns: Array<{ include: string }>;
  repository: Record<string, Rule>;
};
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

/** A rule that matches by itself, or the alternatives it lists. */
const candidatesOf = (rule: Rule): Rule[] => (rule.match ? [rule] : (rule.patterns ?? []));

/** Rules that would colour this line, in the order the grammar lists them (first match wins, as in TextMate). */
function rulesFor(line: string): Array<{ rule: string; match: RegExpExecArray }> {
  const found: Array<{ rule: string; match: RegExpExecArray }> = [];
  for (const { include } of grammar.patterns) {
    const name = include.slice(1);
    const rule = grammar.repository[name]!;
    for (const candidate of candidatesOf(rule)) {
      const m = candidate.match ? new RegExp(candidate.match, 'u').exec(line) : null;
      if (m) {
        found.push({ rule: name, match: m });
      }
    }
  }
  return found;
}

const article: Article = {
  board: 'Dev',
  title: '[討論] 人月神話',
  author: 'alice (愛麗絲)',
  time: 'Tue Nov  3 12:00:00 2026',
  url: 'https://www.ptt.cc/bbs/Dev/M.1.A.B.html',
  bodyLines: [
    '第一行 https://i.imgur.com/a.jpg 好圖',
    '※ 引述《bob (鮑伯)》之銘言：',
    ': 原文',
    '--',
    '※ 發信站: 批踢踢實業坊(ptt.cc)',
  ],
  pushes: [
    { kind: '推', userId: 'u1', content: '推一個', date: '11/03', time: '12:30' },
    { kind: '噓', userId: 'u2', content: '不推', date: '11/03', time: '12:31' },
    { kind: '→', userId: 'u3', content: '補充', date: '11/03', time: '12:32' },
  ],
  verified: true,
  pinnedMirror: false,
  truncated: false,
};

describe('article colouring', () => {
  const lines = renderArticle(article).split('\n');
  const first = (line: string) => rulesFor(line)[0]?.rule;

  it('is declared for .ptt documents and shipped with the extension', () => {
    expect(manifest.contributes.languages).toEqual([
      { id: 'ptt', aliases: ['PTT'], extensions: ['.ptt'] },
    ]);
    expect(manifest.contributes.grammars).toEqual([
      { language: 'ptt', scopeName: grammar.scopeName, path: './syntaxes/ptt.tmLanguage.json' },
    ]);
    expect(grammar.scopeName).toBe('source.ptt');
  });

  it('every rule the grammar includes exists and compiles', () => {
    for (const { include } of grammar.patterns) {
      const rule = grammar.repository[include.slice(1)];
      expect(rule, include).toBeDefined();
      for (const candidate of candidatesOf(rule!)) {
        if (candidate.match) {
          expect(() => new RegExp(candidate.match!, 'u'), candidate.match).not.toThrow();
        }
      }
    }
  });

  it('colours the header, the rules, notices, quotes and the signature line', () => {
    expect(first(lines[0]!)).toBe('header'); // 標題：
    expect(first(lines[1]!)).toBe('header'); // 作者：
    expect(lines.filter((l) => first(l) === 'rule')).toHaveLength(2);
    expect(first('※ 引述《bob (鮑伯)》之銘言：')).toBe('notice');
    expect(first(': 原文')).toBe('quote');
    expect(first('--')).toBe('signature');
  });

  it('colours each kind of push on its own, and finds the time at the end', () => {
    const pushes = lines.filter((l) => /^[推噓→] /u.test(l));
    expect(pushes).toHaveLength(3);
    const [push, boo, arrow] = pushes.map((l) => rulesFor(l).find((r) => r.rule === 'push')!);
    expect(push!.match[1]).toBe('推');
    expect(boo!.match[1]).toBe('噓');
    expect(arrow!.match[1]).toBe('→');
    expect(push!.match[2]).toBe('u1');
    expect(push!.match[4]).toBe('推一個');
    expect(push!.match[5]!.trim()).toBe('11/03 12:30');
  });

  it('finds the address in a body line and stops before the Chinese text after it', () => {
    const line = lines.find((l) => l.includes('i.imgur.com'))!;
    const url = rulesFor(line).find((r) => r.rule === 'url')!;
    expect(url.match[0]).toBe('https://i.imgur.com/a.jpg');
  });

  it('does not colour ordinary text', () => {
    expect(rulesFor('今天天氣很好')).toEqual([]);
  });
});
