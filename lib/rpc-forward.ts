import { limitedBody } from "./http";
let requestSequence = 0;
export async function forwardRpc(
  url: string,
  raw: string,
  method: string,
  id: unknown,
  fetcher: typeof fetch = fetch,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
) {
  const request = ++requestSequence;
  const endpoint =
    url === "https://api.mainnet-beta.solana.com"
      ? "public-mainnet"
      : "configured-mainnet";
  const send = method === "sendTransaction";
  let attempt = 0;
  const failure = (reason: string, status: number) =>
    Response.json(
      {
        jsonrpc: "2.0",
        id: id ?? null,
        error: {
          code: -32000,
          message: `RPC operation ${method}: ${reason}; endpoint=${endpoint}; attempts=${attempt}; request=${request}.${send ? " Broadcast status UNKNOWN; check the saved signature. Do not resend." : ""}`,
        },
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  for (;;) {
    attempt++;
    const start = Date.now();
    let status: number | undefined;
    try {
      const r = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
        signal: AbortSignal.timeout(25000),
        cache: "no-store",
        redirect: "error",
      });
      status = r.status;
      console.info("RPC diagnostic", {
        request,
        method,
        endpoint,
        attempt,
        status,
        durationMs: Date.now() - start,
      });
      if (!r.ok) {
        const retry = r.headers.get("retry-after");
        await r.body?.cancel();
        let wait = 500 * 2 ** (attempt - 1);
        if (retry) {
          const seconds = Number(retry);
          const deadline = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retry) - Date.now();
          if (Number.isFinite(deadline)) wait = Math.max(wait, deadline);
        }
        // Only rate-limited read calls are retried. Never replay a broadcast or wait past budget.
        if (!send && status === 429 && attempt < 3 && wait <= 5000) {
          await sleep(wait);
          continue;
        }
        return failure(`HTTP ${status}`, status === 429 ? 429 : 502);
      }
      return new Response(await limitedBody(r, 4 * 1024 * 1024), {
        status: r.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      const timeout =
        e instanceof Error && ["TimeoutError", "AbortError"].includes(e.name);
      console.info("RPC diagnostic", {
        request,
        method,
        endpoint,
        attempt,
        status,
        outcome: timeout ? "timeout" : "transport-or-response",
        durationMs: Date.now() - start,
      });
      return failure(
        timeout ? "timeout" : "transport or bounded-response failure",
        502,
      );
    }
  }
}
