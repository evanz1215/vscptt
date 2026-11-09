import { describe, expect, it } from 'vitest';
import { DuplicateLoginDeclinedError } from '../../src/core/errors';
import { PttService } from '../../src/core/service';
import { Session } from '../../src/core/session/session';
import { Terminal } from '../../src/core/terminal/terminal';
import { connectSsh } from '../../src/core/transport/sshTransport';
import { connectWs } from '../../src/core/transport/wsTransport';

// Opt-in: talks to the real PTT and logs in with a real account. Never runs in CI or a plain `pnpm test`.
//   PTT_LIVE=1 PTT_USER=<id> PTT_PASS=<password> pnpm exec vitest run test/smoke
// Add PTT_TRANSPORT=ssh to go over SSH instead of WebSocket.
// Read-only. A duplicate-login prompt is always answered "keep" so no other connection is logged out. PTT then
// closes this connection, which is a property of the account's state, not a failure of the code: the test is
// skipped with a reason instead of passing or failing.
const live = process.env.PTT_LIVE === '1' && !!process.env.PTT_USER && !!process.env.PTT_PASS;
const BOARD = process.env.PTT_BOARD ?? 'Soft_Job';
// PTT_TRANSPORT=ssh runs the same test over SSH. The host key must be the one recorded in docs/plan.md 2.1
// (seen again on 2026-11-05); PTT_SSH_FINGERPRINT overrides it if PTT changes its key.
const SSH = process.env.PTT_TRANSPORT === 'ssh';
const FINGERPRINT =
  process.env.PTT_SSH_FINGERPRINT ?? 'SHA256:oTf7wY7klc9gi0FHhYQNHQu7aJfYGz/bFLSpdOxhbxg';

describe.skipIf(!live)('live PTT smoke test', () => {
  it(
    'logs in, reads favorites, a board (two pages), an article and a pinned one, then logs out',
    { timeout: 120_000 },
    async ({ skip }) => {
      const user = process.env.PTT_USER!;
      const pass = process.env.PTT_PASS!;

      const session = SSH
        ? new Session(await connectSsh({ verifyHostKey: (fp) => fp === FINGERPRINT }), {
            duplicateSession: 'keep',
            terminal: new Terminal({ encoding: 'utf-8' }),
          })
        : new Session(await connectWs(), { duplicateSession: 'keep' });
      const service = new PttService(session);

      try {
        try {
          await service.login({ username: user, password: pass });
        } catch (error) {
          if (error instanceof DuplicateLoginDeclinedError) {
            skip('the account is already logged in elsewhere and the other connection was kept');
          }
          throw error;
        }
        expect(service.state).toBe('ready');
        expect(session.lines.join('\n')).not.toContain(pass);

        // favorites
        const favorites = await service.getFavorites();
        expect(Array.isArray(favorites)).toBe(true);
        for (const f of favorites) {
          expect(f.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
        }

        // entering boards: a real one, one that does not exist
        expect(await service.openBoard(BOARD)).toBe(true);
        expect(await service.openBoard('NoSuchBoardZzqx')).toBe(false);

        // the latest page and the one after it join without a gap
        const latest = await service.getBoardPage(BOARD);
        expect(latest.board.toLowerCase()).toBe(BOARD.toLowerCase());
        expect(latest.articles.length).toBeGreaterThanOrEqual(10);
        const numbers = latest.articles.map((a) => a.listNumber!);
        expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
        expect(numbers[0]! - numbers.at(-1)!).toBe(numbers.length - 1); // contiguous

        expect(latest.hasOlder).toBe(true);
        const older = await service.getBoardPage(BOARD, latest.next);
        expect(older.articles[0]!.listNumber).toBe(latest.next!.before - 1);
        expect(older.pinned).toEqual([]);

        // a normal article: identified, read, and checked against the entry
        const target = latest.articles.find((a) => a.kind === 'normal') ?? latest.articles[0]!;
        const resolved = await service.resolveArticleId({
          board: BOARD,
          listNumber: target.listNumber,
          title: target.title,
        });
        expect(resolved.id).toMatch(/^M\.\d+\.A\.[0-9A-F]+$/);
        expect(resolved.aid).toMatch(/^#\S+$/);

        const read = await service.getArticle({
          board: BOARD,
          listNumber: target.listNumber,
          title: target.title,
          id: resolved.id,
        });
        expect(read.verified).toBe(true);
        expect(read.id).toBe(resolved.id);
        expect(read.url).toContain(resolved.id);
        expect(read.bodyLines.length).toBeGreaterThan(0);
        expect(read.truncated).toBe(false);

        // the same article found again by its id (`#` and the article code)
        const found = await service.findArticle(BOARD, resolved.id);
        expect(found.listNumber).toBe(target.listNumber);

        // a pinned article, if the board has one
        if (latest.pinned.length > 0) {
          const pinned = await service.getArticle({
            board: BOARD,
            isPinned: true,
            pinnedIndex: 0,
            title: latest.pinned[0]!.title,
          });
          expect(pinned.verified).toBe(true);
        }

        // the connection is still usable after all of that
        expect(await service.openBoard(BOARD)).toBe(true);
      } catch (error) {
        // Show what the screen looked like (account name and IP addresses are masked) to make a
        // surprise from the real server diagnosable.
        console.error(`live test failed; screen:\n${session.snapshot().join('\n')}`);
        throw error;
      } finally {
        await service.logout();
      }

      expect(session.state).toBe('disconnected');
      // WebSocket ends with code 1000; SSH has no codes and reports that the shell closed.
      expect(await session.closed).toMatchObject(
        SSH ? { reason: 'bbs disconnected' } : { code: 1000 }
      );
    }
  );
});
