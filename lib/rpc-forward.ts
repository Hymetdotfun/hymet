import { limitedBody } from "./http";
import { DEVNET_RPC_URL } from "./app-network";
let requestSequence = 0;
// Read retries on HTTP 429. Public Devnet rate-limits per method per 10-second window and answers with a Retry-After of
// several seconds, so the Devnet test network gets a longer budget; every other endpoint keeps the original one.
const RETRY = {
  default: { attempts: 3, maxWait: 5_000, budget: 5_000 },
  devnet: { attempts: 6, maxWait: 10_000, budget: 30_000 },
};
/** Diagnostic label only (never the URL, which can carry credentials). */
export function rpcEndpointLabel(url: string) {
  if (url === "https://api.mainnet-beta.solana.com") return "public-mainnet";
  if (url === DEVNET_RPC_URL) return "devnet";
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/.test(url)) return "localnet";
  return "configured-mainnet";
}
export async function forwardRpc(
  url: string,
  raw: string,
  method: string,
  id: unknown,
  fetcher: typeof fetch = fetch,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
) {
  const request = ++requestSequence;
  const endpoint = rpcEndpointLabel(url);
  const policy = endpoint === "devnet" ? RETRY.devnet : RETRY.default;
  const send = method === "sendTransaction";
  let attempt = 0, waited = 0;
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
        if (!send && status === 429 && attempt < policy.attempts && wait <= policy.maxWait && waited + wait <= policy.budget) {
          waited += wait;
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
