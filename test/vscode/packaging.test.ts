import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

describe('what goes into the .vsix', () => {
  it(
    'ships only the manifest, the readme, the icon and the built extension',
    { timeout: 60_000 },
    async () => {
      // Dependencies are bundled into out/extension.js by esbuild, so none are packaged separately.
      // The CLI is used because the library's listFiles() cannot skip the dependency scan in its typings.
      const { stdout } = await run(
        process.execPath,
        ['node_modules/@vscode/vsce/vsce', 'ls', '--no-dependencies'],
        { cwd: process.cwd() }
      );
      const files = stdout
        .split(/\r?\n/)
        .map((f) => f.trim().replace(/\\/g, '/'))
        .filter(Boolean)
        .sort();

      // Local task logs, plans, sources and tests must never be published.
      for (const file of files) {
        expect(file, file).not.toMatch(/^(\.doit|docs|src|test|node_modules|\.vscode)\//);
      }
      expect(files).toEqual([
        'LICENSE',
        'README.md',
        'media/ptt.svg',
        'out/extension.js',
        'package.json',
      ]);
    }
  );
});
