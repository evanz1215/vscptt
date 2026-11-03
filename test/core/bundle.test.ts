import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The extension ships as an esbuild CJS bundle, which resolves CommonJS dependencies differently from
// vitest. This test bundles the core modules the same way and loads the result, so interop mistakes
// (for example a default import that is undefined only in the bundle) fail here instead of at runtime.
describe('esbuild bundle of the core modules', () => {
  let dir: string;
  let load: (name: string) => Record<string, unknown>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vscptt-bundle-'));
    buildSync({
      entryPoints: {
        terminal: 'src/core/terminal/terminal.ts',
        wsTransport: 'src/core/transport/wsTransport.ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
      outdir: dir,
      logLevel: 'silent',
    });
    const require = createRequire(join(dir, 'x.js'));
    load = (name) => require(join(dir, `${name}.js`));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads Terminal and renders wide characters', async () => {
    const { Terminal } = load('terminal') as {
      Terminal: typeof import('../../src/core/terminal/terminal').Terminal;
    };
    const term = new Terminal();
    await term.write(new TextEncoder().encode('中文'));
    expect(term.line(0)).toBe('中文');
    term.dispose();
  });

  it('loads the WebSocket transport', () => {
    const mod = load('wsTransport') as { connectWs: unknown; PTT_WS_ORIGIN: string };
    expect(typeof mod.connectWs).toBe('function');
    expect(mod.PTT_WS_ORIGIN).toBe('https://term.ptt.cc');
  });
});
