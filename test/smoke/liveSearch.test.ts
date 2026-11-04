import { describe, expect, it } from 'vitest';
import { DuplicateLoginDeclinedError } from '../../src/core/errors';
import { PttService } from '../../src/core/service';
import { Session } from '../../src/core/session/session';
import { connectWs } from '../../src/core/transport/wsTransport';

// Opt-in, read-only; see live.test.ts. A busy account (duplicate login) skips the test.
//   PTT_LIVE=1 PTT_USER=<id> PTT_PASS=<password> pnpm exec vitest run test/smoke/liveSearch.test.ts
const live = process.env.PTT_LIVE === '1' && !!process.env.PTT_USER && !!process.env.PTT_PASS;
const BOARD = process.env.PTT_BOARD ?? 'Soft_Job';

describe.skipIf(!live)('live PTT search', () => {
  it(
    'searches by title, author and push count, pages, opens a result, and logs out',
    { timeout: 180_000 },
    async ({ skip }) => {
      const session = new Session(await connectWs(), { duplicateSession: 'keep' });
      const service = new PttService(session);
      try {
        try {
          await service.login({ username: process.env.PTT_USER!, password: process.env.PTT_PASS! });
        } catch (error) {
          if (error instanceof DuplicateLoginDeclinedError) {
            skip('the account is already logged in elsewhere and the other connection was kept');
          }
          throw error;
        }

        // title: every hit contains the word, and the results are numbered within themselves
        const byTitle = await service.searchBoard(BOARD, { kind: 'title', text: '請益' });
        expect(byTitle.articles.length).toBeGreaterThanOrEqual(10);
        expect(byTitle.articles.every((a) => a.title.includes('請益'))).toBe(true);
        const n = byTitle.articles.map((a) => a.listNumber!);
        expect(n).toEqual([...n].sort((a, b) => b - a));
        expect(n[0]! - n.at(-1)!).toBe(n.length - 1);

        // older results join without a gap
        expect(byTitle.hasOlder).toBe(true);
        const older = await service.searchBoard(
          BOARD,
          { kind: 'title', text: '請益' },
          byTitle.next
        );
        expect(older.articles[0]!.listNumber).toBe(byTitle.next!.before - 1);
        expect(older.articles.every((a) => a.title.includes('請益'))).toBe(true);

        // author and push count
        const byAuthor = await service.searchBoard(BOARD, { kind: 'author', text: 'MOONY135' });
        expect(byAuthor.articles.length).toBeGreaterThan(0);
        expect(byAuthor.articles.every((a) => a.author.toLowerCase().startsWith('moony135'))).toBe(
          true
        );
        const byPush = await service.searchBoard(BOARD, { kind: 'push', threshold: 30 });
        expect(byPush.articles.length).toBeGreaterThan(0);

        // nothing found
        const none = await service.searchBoard(BOARD, { kind: 'title', text: 'zzqqxxkkvv' });
        expect(none.articles).toEqual([]);

        // open a result: it must be the one that was clicked
        const hit = byTitle.articles.find((a) => a.kind === 'normal')!;
        const article = await service.getArticle({
          board: BOARD,
          listNumber: hit.listNumber,
          title: hit.title,
          author: hit.author,
          search: hit.search,
        });
        expect(article.verified).toBe(true);
        expect(article.title).toContain('請益');

        // the normal list is unaffected afterwards
        const normal = await service.getBoardPage(BOARD);
        expect(normal.pinned.length).toBeGreaterThanOrEqual(0);
        expect(normal.articles.length).toBeGreaterThanOrEqual(10);
        expect(session.lines.join('\n')).not.toContain(process.env.PTT_PASS!);
      } finally {
        await service.logout().catch(() => {});
      }
    }
  );
});
