import { describe, expect, it } from 'vitest';
import { OpenedBoards } from '../../src/vscode/openedBoards';

function make(initial?: unknown) {
  const state = new Map<string, unknown>();
  if (initial !== undefined) {
    state.set('vscptt.openedBoards', initial);
  }
  return new OpenedBoards({
    get: <T>(k: string) => state.get(k) as T | undefined,
    update: async (k, v) => void (v === undefined ? state.delete(k) : state.set(k, v)),
  });
}

describe('OpenedBoards', () => {
  it('starts empty', () => {
    expect(make().list()).toEqual([]);
  });

  it('puts the most recent board first', async () => {
    const boards = make();
    await boards.add('Soft_Job');
    await boards.add('Stock');
    expect(boards.list()).toEqual(['Stock', 'Soft_Job']);
  });

  it('moves a board to the front instead of listing it twice, ignoring case', async () => {
    const boards = make();
    await boards.add('Soft_Job');
    await boards.add('Stock');
    await boards.add('soft_job');
    expect(boards.list()).toEqual(['soft_job', 'Stock']);
  });

  it('keeps at most 20', async () => {
    const boards = make();
    for (let i = 0; i < 30; i++) {
      await boards.add(`Board${i}`);
    }
    expect(boards.list()).toHaveLength(20);
    expect(boards.list()[0]).toBe('Board29');
  });

  it('removes one board or all of them', async () => {
    const boards = make(['A', 'B', 'C']);
    await boards.remove('b');
    expect(boards.list()).toEqual(['A', 'C']);
    await boards.clear();
    expect(boards.list()).toEqual([]);
  });

  it('ignores stored data that is not a list of names', () => {
    expect(make('oops').list()).toEqual([]);
    expect(make({ a: 1 }).list()).toEqual([]);
    expect(make(['A', 5, null, 'B']).list()).toEqual(['A', 'B']);
  });
});
