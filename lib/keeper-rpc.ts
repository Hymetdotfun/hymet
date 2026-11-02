// Keeper RPC transport. Every request is bounded by a timeout, and a read that fails at the transport layer (e.g. a
// keep-alive socket the RPC closed while the keeper waited) is retried once on a fresh request. A broadcast is never
// replayed: a failed sendTransaction surfaces as an error and the keeper resumes from chain state on its next run.
export function keeperFetch(timeoutMs: number, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const call = () => fetcher(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    try {
      return await call();
    } catch (error) {
      const transport = error instanceof TypeError; // undici "fetch failed"; timeouts are DOMExceptions
      if (!transport || /"sendTransaction"/.test(String(init?.body ?? ""))) throw error;
      return call();
    }
  };
}
