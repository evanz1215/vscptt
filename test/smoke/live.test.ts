import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../../src/core/queue/commandQueue';
import { waitFor } from '../../src/core/queue/waitFor';
import { waitForQuiet } from '../../src/core/terminal/settle';
import { Terminal } from '../../src/core/terminal/terminal';
import type { CloseInfo } from '../../src/core/transport/transport';
import { connectWs } from '../../src/core/transport/wsTransport';

// Opt-in: talks to the real PTT. Never runs in CI or a plain `pnpm test`.
//   PTT_LIVE=1 PTT_USER=<id> PTT_PASS=<password> pnpm exec vitest run test/smoke
const live = process.env.PTT_LIVE === '1' && !!process.env.PTT_USER && !!process.env.PTT_PASS;

describe.skipIf(!live)('live PTT smoke test', () => {
  it('logs in, reaches the main menu, and logs out cleanly', { timeout: 90_000 }, async () => {
    const user = process.env.PTT_USER!;
    const pass = process.env.PTT_PASS!;

    const terminal = new Terminal({ encoding: 'big5' }); // the gateway starts in Big5
    const transport = await connectWs();
    transport.onData((d) => void terminal.write(d));
    const closed = new Promise<CloseInfo>((resolve) => transport.onClose(resolve));
    const queue = new CommandQueue();

    try {
      await waitFor(terminal, (t) => t.text().includes('guest'), {
        timeoutMs: 10_000,
        description: 'login prompt',
      });

      await queue.run(async () => {
        terminal.setEncoding('utf-8'); // a trailing comma switches the session to UTF-8
        transport.send(`${user},\r`);
        // Match the full prompt: the Big5 splash also contains "忘記密碼可參考…", which would match too early.
        await waitFor(terminal, (t) => t.text().includes('請輸入您的密碼'), {
          timeoutMs: 10_000,
          description: 'password prompt',
        });
      });

      await queue.run(async () => {
        transport.send(`${pass}\r`);
        for (let step = 0; step < 6; step++) {
          const screen = await waitFor(
            terminal,
            (t) => {
              if (t.line(0).includes('主功能表')) return 'menu';
              if (t.text().includes('重複登入')) return 'duplicate';
              if (t.text().includes('任意鍵')) return 'anykey';
              return false;
            },
            { timeoutMs: 20_000, description: 'a post-login screen' }
          );
          if (screen === 'menu') {
            return;
          }
          transport.send(screen === 'duplicate' ? 'n\r' : ' '); // never kick another session
          await waitForQuiet(terminal, { quietMs: 200 });
        }
        throw new Error('did not reach the main menu');
      });

      expect(terminal.line(0)).toContain('主功能表');
      expect(terminal.text()).not.toContain(pass);

      await queue.run(async () => {
        transport.send('G\r');
        await waitFor(terminal, (t) => t.text().includes('您確定要離開'), {
          timeoutMs: 10_000,
          description: 'logout confirmation',
        });
        transport.send('Y\r');
        await waitFor(terminal, (t) => t.text().includes('任意鍵'), {
          timeoutMs: 10_000,
          description: 'goodbye screen',
        });
        transport.send(' ');
      });

      const info = await Promise.race([
        closed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('server did not close the connection')), 10_000)
        ),
      ]);
      expect(info.code).toBe(1000);
    } finally {
      transport.close();
      terminal.dispose();
    }
  });
});
