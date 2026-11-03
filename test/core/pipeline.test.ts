import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../../src/core/queue/commandQueue';
import { waitFor } from '../../src/core/queue/waitFor';
import { Terminal } from '../../src/core/terminal/terminal';
import { FakeTransport } from '../fakes/fakeTransport';

// Big5 bytes for the pre-login splash: "請輸入代號，或以 guest 參觀" (only the ASCII tail matters to the matcher).
const BIG5_SPLASH = new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5, ...new TextEncoder().encode(' guest')]);

function wire(transport: FakeTransport, terminal: Terminal) {
  transport.onData((d) => void terminal.write(d));
}

describe('transport -> terminal -> waitFor pipeline', () => {
  it('walks a login-shaped exchange, switching Big5 to UTF-8 when the username ends with a comma', async () => {
    const transport = new FakeTransport((sent, t) => {
      if (sent === 'alice,\r') {
        t.push('\r\n請輸入您的密碼:');
      } else if (sent === 'secret\r') {
        t.push('\x1b[2J\x1b[H【主功能表】');
      }
    });
    const terminal = new Terminal({ encoding: 'big5' });
    wire(transport, terminal);
    const queue = new CommandQueue();

    transport.push(BIG5_SPLASH);
    await waitFor(terminal, (t) => t.text().includes('guest'), {
      timeoutMs: 500,
      description: 'login prompt',
    });

    await queue.run(async () => {
      terminal.setEncoding('utf-8'); // everything after the comma is UTF-8; switch before sending
      transport.send('alice,\r');
      await waitFor(terminal, (t) => t.text().includes('密碼'), {
        timeoutMs: 500,
        description: 'password prompt',
      });
    });

    await queue.run(async () => {
      transport.send('secret\r');
      await waitFor(terminal, (t) => t.line(0).includes('主功能表'), {
        timeoutMs: 500,
        description: 'main menu',
      });
    });

    expect(transport.sent).toEqual(['alice,\r', 'secret\r']);
    expect(terminal.line(0)).toBe('【主功能表】');
  });

  it('serialises commands: a second command does not run until the first screen arrives', async () => {
    const transport = new FakeTransport();
    const terminal = new Terminal();
    wire(transport, terminal);
    const queue = new CommandQueue();

    const first = queue.run(async () => {
      transport.send('first');
      await waitFor(terminal, (t) => t.line(0).includes('A'), { timeoutMs: 500 });
    });
    const second = queue.run(async () => {
      transport.send('second');
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(transport.sent).toEqual(['first']); // second is still waiting its turn

    transport.push('A');
    await first;
    await second;
    expect(transport.sent).toEqual(['first', 'second']);
  });

  it('surfaces a server-side close to listeners', () => {
    const transport = new FakeTransport();
    const closes: unknown[] = [];
    transport.onClose((info) => closes.push(info));
    transport.serverClose({ code: 1006 });
    transport.serverClose({ code: 1006 }); // second close is ignored
    expect(closes).toEqual([{ code: 1006 }]);
    expect(() => transport.send('x')).toThrow();
  });
});
