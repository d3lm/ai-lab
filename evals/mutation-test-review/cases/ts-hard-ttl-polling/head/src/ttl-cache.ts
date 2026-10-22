export type Clock = () => number;

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * A map whose entries expire `ttlMs` after they were last written.
 * An entry is expired once `now >= expiresAt`.
 */
export class TtlCache<K, V> {
  private entries = new Map<K, Entry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: Clock = Date.now,
  ) {}

  set(key: K, value: V): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Removes expired entries and returns how many were removed. */
  prune(): number {
    let removed = 0;
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
