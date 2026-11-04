import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  it('runs login, a board page and an article end to end inside the bundle', async () => {
    // Bundle the real session and service together with the fake server, then drive them from here.
    buildSync({
      stdin: {
        contents: [
          "export { FakeBbs } from './test/fakes/fakeBbs';",
          "export { Session } from './src/core/session/session';",
          "export { PttService } from './src/core/service';",
        ].join('\n'),
        resolveDir: process.cwd(),
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
      outfile: join(dir, 'e2e.js'),
      logLevel: 'silent',
    });
    const { FakeBbs, Session, PttService } = load('e2e') as {
      FakeBbs: typeof import('../fakes/fakeBbs').FakeBbs;
      Session: typeof import('../../src/core/session/session').Session;
      PttService: typeof import('../../src/core/service').PttService;
    };

    const bbs = new FakeBbs({
      boards: {
        Dev: [
          { id: 'M.1.A.001', author: 'a', title: 'first' },
          { id: 'M.2.A.002', author: 'b', title: 'second' },
        ],
      },
    });
    const service = new PttService(new Session(bbs.connect(), { keepAliveMs: 0 }));
    await service.login({ username: 'alice', password: 'secret' });

    const page = await service.getBoardPage('Dev');
    expect(page.articles.map((a) => a.title)).toEqual(['second', 'first']);
    const article = await service.getArticle({ board: 'Dev', listNumber: 2 });
    expect(article).toMatchObject({ id: 'M.2.A.002', verified: true });
    await service.logout();
  });
  it('activates the real extension entry point from the bundle and registers every declared command', async () => {
    // The real `vscode` module only exists inside VS Code, so the stand-in is bundled in its place. Exporting
    // it from the same bundle lets the test see what the extension did to it.
    buildSync({
      stdin: {
        contents: [
          "export * from './src/extension';",
          "export { mock } from './test/mocks/vscode';",
        ].join('\n'),
        resolveDir: process.cwd(),
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      alias: { vscode: join(process.cwd(), 'test/mocks/vscode.ts') },
      outfile: join(dir, 'ext.js'),
      logLevel: 'silent',
    });
    const { activate, deactivate, mock } = load('ext') as {
      activate: (context: unknown) => void;
      deactivate: () => Promise<void> | undefined;
      mock: {
        commands: Map<string, unknown>;
        treeViews: Array<{ id: string }>;
        statusItems: unknown[];
      };
    };

    const state = new Map<string, unknown>();
    activate({
      subscriptions: [],
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
      globalState: {
        get: (k: string) => state.get(k),
        update: async (k: string, v: unknown) => void state.set(k, v),
      },
    });

    const declared = JSON.parse(readFileSync('package.json', 'utf8')).contributes.commands.map(
      (c: { command: string }) => c.command
    );
    expect([...mock.commands.keys()].sort()).toEqual([...declared].sort());
    expect(mock.treeViews.map((v) => v.id)).toEqual(['vscptt.boards']);
    expect(mock.statusItems).toHaveLength(1);
    await deactivate(); // nothing is connected, so there is nothing to log out of
  });
});
