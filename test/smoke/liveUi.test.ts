import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { createExtension, deactivate } from '../../src/extension';
import type { BoardsTreeProvider } from '../../src/vscode/boardsTree';
import { mock } from '../mocks/vscode';

// Opt-in: talks to the real PTT and logs in with a real account. Never runs in CI or a plain `pnpm test`.
//   PTT_LIVE=1 PTT_USER=<id> PTT_PASS=<password> pnpm exec vitest run test/smoke/liveUi.test.ts
// Everything except the VS Code windows is real: commands, connection manager, tree, article documents.
// Read-only. If the account is already logged in elsewhere the dialog is dismissed ("keep the other
// connection"), PTT refuses this login, and the test is skipped with a reason.
const live = process.env.PTT_LIVE === '1' && !!process.env.PTT_USER && !!process.env.PTT_PASS;
const BOARD = process.env.PTT_BOARD ?? 'Soft_Job';

describe.skipIf(!live)('live PTT through the extension', () => {
  it(
    'logs in, opens a board, reads an article, copies its address, and logs out',
    { timeout: 120_000 },
    async ({ skip }) => {
      const user = process.env.PTT_USER!;
      const pass = process.env.PTT_PASS!;

      mock.reset();
      if (process.env.PTT_TRANSPORT === 'ssh') {
        mock.config.set('vscptt.connection.transport', 'ssh');
      }
      const state = new Map<string, unknown>();
      const context = {
        subscriptions: [] as Array<{ dispose(): unknown }>,
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
        globalState: {
          get: <T>(k: string) => state.get(k) as T | undefined,
          update: async (k: string, v: unknown) => void state.set(k, v),
        },
      } as unknown as vscode.ExtensionContext;

      const { connection } = createExtension(context);
      const tree = mock.treeViews[0]!.provider as BoardsTreeProvider;
      const run = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(id, ...args);

      try {
        mock.inputAnswers.push(user, pass);
        mock.quickPickAnswers.push('都不記住');
        await run('vscptt.login');
        if (
          connection.state !== 'ready' &&
          mock.messages.some((m) => m.message.includes('已在別處登入'))
        ) {
          skip('the account is already logged in elsewhere and the other connection was kept');
        }
        expect(connection.state).toBe('ready');
        expect(mock.contexts.get('vscptt.loggedIn')).toBe(true);
        expect(mock.statusItems[0]!.text).toContain(user);

        // favorites load without error
        const [favorites, opened] = await tree.getChildren();
        const favoriteNodes = await tree.getChildren(favorites);
        expect(favoriteNodes.every((n) => n.kind === 'board' || n.kind === 'message')).toBe(true);
        expect(favoriteNodes.some((n) => n.kind === 'message' && n.icon === 'warning')).toBe(false);

        // open a board by name; it appears under "opened boards"
        mock.inputAnswers.push(BOARD);
        await run('vscptt.openBoard');
        const boardNode = (await tree.getChildren(opened)).find(
          (n) => n.kind === 'board' && n.board.toLowerCase() === BOARD.toLowerCase()
        )!;
        expect(boardNode).toBeDefined();

        // its articles, newest first, with older ones available
        const children = await tree.getChildren(boardNode);
        const articles = children.filter((n) => n.kind === 'article');
        expect(articles.length).toBeGreaterThanOrEqual(10);
        const more = children.find((n) => n.kind === 'loadMore')!;
        expect(more).toBeDefined();
        const moreCommand = tree.getTreeItem(more).command!;
        await run(moreCommand.command, ...(moreCommand.arguments ?? []));
        const after = await tree.getChildren(boardNode);
        expect(after.filter((n) => n.kind === 'article').length).toBeGreaterThan(articles.length);

        // read a normal article through the command the tree item carries
        const target = articles.find((n) => n.kind === 'article' && n.summary.kind === 'normal')!;
        const command = tree.getTreeItem(target).command!;
        await run(command.command, ...(command.arguments ?? []));
        expect(mock.shownTexts).toHaveLength(1);
        expect(mock.shownTexts[0]).toContain('標題：');
        expect(mock.shownTexts[0]).toContain(
          `看板：${boardNode.kind === 'board' ? boardNode.board : ''}`
        );
        expect(mock.shownTexts[0]).not.toContain('無法開啟這篇文章');
        expect(mock.shownTexts[0]).not.toContain('無法把這篇文章的內容和清單項目核對');

        // copy its address
        await run('vscptt.copyArticleUrl', target);
        expect(mock.clipboard).toMatch(
          /^https:\/\/www\.ptt\.cc\/bbs\/[^/]+\/M\.\d+\.A\.[0-9A-F]+\.html$/
        );

        // the password was never shown anywhere
        const visible = JSON.stringify([
          mock.messages,
          mock.inputBoxes.map((b) => b.prompt),
          mock.quickPickCalls,
          mock.clipboard,
          mock.statusItems.map((s) => [s.text, s.tooltip]),
          mock.shownTexts,
        ]);
        expect(visible).not.toContain(pass);

        await run('vscptt.logout');
        expect(connection.state).toBe('disconnected');
        expect(mock.statusItems[0]!.text).toContain('未登入');
      } finally {
        await deactivate();
      }
    }
  );
});
