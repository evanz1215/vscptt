import { describe, expect, it } from 'vitest';
import { UnexpectedScreenError, redactLine } from '../../src/core/errors';
import { WaitTimeoutError } from '../../src/core/queue/waitFor';

describe('redactLine', () => {
  it('masks IPv4 addresses', () => {
    expect(redactLine('上次您是從 192.0.2.44 連往本站。')).toBe('上次您是從 0.0.0.0 連往本站。');
    expect(redactLine('a 1.2.3.4 b 10.0.0.255 c')).toBe('a 0.0.0.0 b 0.0.0.0 c');
  });

  it('masks the given secrets regardless of case, and only them', () => {
    expect(redactLine('主選單 | Alice | 線上3人', ['alice'])).toBe('主選單 | <user> | 線上3人');
    expect(redactLine('alice and bob', ['alice'])).toBe('<user> and bob');
  });

  it('treats a secret literally, not as a pattern', () => {
    expect(redactLine('a.b and axb', ['a.b'])).toBe('<user> and axb');
    expect(() => redactLine('x', ['(', '[', '*'])).not.toThrow();
  });

  it('leaves ordinary text alone', () => {
    expect(redactLine('11/01 10:40 版本 1.2')).toBe('11/01 10:40 版本 1.2');
  });
});

describe('error snapshots', () => {
  it('UnexpectedScreenError masks IP addresses', () => {
    const e = new UnexpectedScreenError('x', ['from 198.51.100.7 (臺灣)', 'ok']);
    expect(e.snapshot).toEqual(['from 0.0.0.0 (臺灣)', 'ok']);
  });

  it('WaitTimeoutError masks IP addresses', () => {
    const e = new WaitTimeoutError('x', 10, ['來自: 198.51.100.7']);
    expect(e.snapshot).toEqual(['來自: 0.0.0.0']);
  });
});
