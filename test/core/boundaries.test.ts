import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('core boundaries', () => {
  it('src/core never imports vscode', () => {
    const offenders = walk('src/core')
      .filter((f) => f.endsWith('.ts'))
      .filter((f) =>
        /from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)/.test(readFileSync(f, 'utf8'))
      );
    expect(offenders).toEqual([]);
  });
});
