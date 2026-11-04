import type { MementoLike } from './credentialStore';

const KEY = 'vscptt.openedBoards';
const LIMIT = 20;

/** Boards the user opened by name, most recent first. Kept across restarts. */
export class OpenedBoards {
  constructor(private readonly state: MementoLike) {}

  list(): string[] {
    const stored = this.state.get<unknown>(KEY);
    return Array.isArray(stored) ? stored.filter((b): b is string => typeof b === 'string') : [];
  }

  async add(name: string): Promise<void> {
    const rest = this.list().filter((b) => b.toLowerCase() !== name.toLowerCase());
    await this.state.update(KEY, [name, ...rest].slice(0, LIMIT));
  }

  async remove(name: string): Promise<void> {
    await this.state.update(
      KEY,
      this.list().filter((b) => b.toLowerCase() !== name.toLowerCase())
    );
  }

  async clear(): Promise<void> {
    await this.state.update(KEY, undefined);
  }
}
