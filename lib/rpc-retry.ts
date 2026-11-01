// Bounded retry for read-only RPC calls that hit public-endpoint rate limits or transient transport failures.
// Never used for sendTransaction: a broadcast must not be replayed.
export function isTransientRpcError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|502|503|504)\b|Too Many Requests|rate.?limit|timed? ?out|timeout|fetch failed|ECONNRESET|ETIMEDOUT|transport/i.test(message);
}

export async function withRpcRetry<T>(
  read: () => Promise<T>,
  {
    attempts = 3,
    baseMs = 1_000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: { attempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= attempts || !isTransientRpcError(error)) throw error;
      // Exponential backoff with jitter: ~1s, ~2s, ~4s for the defaults.
      await sleep(baseMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
    }
  }
}

/** Shares one in-flight read per key and reuses its result for ttlMs (display refreshes only). */
export function dedupedRead<A extends unknown[], T>(ttlMs: number, key: (...args: A) => string, read: (...args: A) => Promise<T>) {
  const cache = new Map<string, { at: number; value?: T; pending?: Promise<T> }>();
  return (...args: A): Promise<T> => {
    const k = key(...args), hit = cache.get(k);
    if (hit?.pending) return hit.pending;
    if (hit && hit.value !== undefined && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    const pending = read(...args).then(
      (value) => { cache.set(k, { at: Date.now(), value }); return value; },
      (error) => { cache.delete(k); throw error; },
    );
    cache.set(k, { at: Date.now(), pending });
    return pending;
  };
}
