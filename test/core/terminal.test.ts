import { describe, expect, it } from 'vitest';
import { Terminal } from '../../src/core/terminal/terminal';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('Terminal', () => {
  it('is 80x24 with 24 lines', async () => {
    const t = new Terminal();
    expect(t.cols).toBe(80);
    expect(t.rows).toBe(24);
    expect(t.lines()).toHaveLength(24);
  });

  it('renders text and wide characters, and tracks the cursor in cells', async () => {
    const t = new Terminal();
    await t.write(utf8('\x1b[2J\x1b[H中文ABC'));
    expect(t.line(0)).toBe('中文ABC');
    expect(t.cursor).toEqual({ x: 7, y: 0 }); // 2 wide chars = 4 cells + 3 ascii
  });

  it('honours absolute cursor positioning', async () => {
    const t = new Terminal();
    await t.write(utf8('\x1b[3;5Hx'));
    expect(t.line(2)).toBe('    x');
  });

  it('decodes a multi-byte character split across writes', async () => {
    const t = new Terminal();
    const bytes = utf8('中');
    await t.write(bytes.slice(0, 1));
    await t.write(bytes.slice(1));
    expect(t.line(0)).toBe('中');
  });

  it('decodes Big5 until the encoding is switched to UTF-8', async () => {
    const t = new Terminal({ encoding: 'big5' });
    await t.write(new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5])); // 中文 in Big5
    expect(t.line(0)).toBe('中文');

    t.setEncoding('utf-8');
    await t.write(utf8('\r\n密碼'));
    expect(t.line(1)).toBe('密碼');
  });

  it('notifies listeners after each parsed write and supports unsubscribe', async () => {
    const t = new Terminal();
    let calls = 0;
    const off = t.onUpdate(() => calls++);
    await t.write(utf8('a'));
    await t.write(utf8('b'));
    off();
    await t.write(utf8('c'));
    expect(calls).toBe(2);
  });
});
