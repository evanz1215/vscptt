import type { MementoLike } from './credentialStore';

const KEY = 'vscptt.sshHostKey';

/**
 * Trust on first use for PTT's SSH host key (docs/plan.md D10, R11): the first fingerprint seen is kept in
 * globalState, and a different one later is refused until the user clears the remembered key.
 */
export class HostKeyStore {
  constructor(
    private readonly state: MementoLike,
    private readonly onFirstTrust: (fingerprint: string) => void = () => {}
  ) {}

  get known(): string | undefined {
    return this.state.get<string>(KEY);
  }

  async check(fingerprint: string): Promise<boolean> {
    const known = this.known;
    if (known === undefined) {
      await this.state.update(KEY, fingerprint);
      this.onFirstTrust(fingerprint);
      return true;
    }
    return known === fingerprint;
  }

  forget(): PromiseLike<void> {
    return this.state.update(KEY, undefined);
  }
}
