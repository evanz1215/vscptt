interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** In-memory cache with per-entry TTL, de-duplication of concurrent loads, and a clock you can replace in tests. */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  /** Bumped by clear() so a load that started earlier cannot repopulate the cache afterwards. */
  private generation = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** Returns the cached value, or runs `loader` once even if several callers ask at the same time. */
  async getOrLoad(
    key: string,
    ttlMs: number,
    loader: () => Promise<V>,
    shouldCache: (value: V) => boolean = () => true
  ): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }

    const generation = this.generation;
    const load = loader()
      .then((value) => {
        if (generation === this.generation && shouldCache(value)) {
          this.set(key, value, ttlMs);
        }
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === load) {
          this.inflight.delete(key);
        }
      });
    this.inflight.set(key, load);
    return load;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of this.entries.keys()) {
      if (predicate(key)) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.generation++;
    this.entries.clear();
    this.inflight.clear();
  }
}
