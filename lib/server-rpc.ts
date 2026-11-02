// Server-side RPC connection. On the Devnet test network every request goes through forwardRpc, so public Devnet's
// 429s get the same bounded, Retry-After-aware budget as the browser proxy (web3.js's own retries give up before
// Devnet's rate-limit window resets, which lost a confirmed launch's registration). Other endpoints are unchanged.
import { Connection, type Commitment } from "@solana/web3.js";
import { serverRpcUrl } from "./app-network";
import { forwardRpc, rpcEndpointLabel } from "./rpc-forward";

export function serverConnection(commitment: Commitment = "confirmed") {
  const url = serverRpcUrl();
  if (rpcEndpointLabel(url) !== "devnet") return new Connection(url, commitment);
  return new Connection(url, {
    commitment,
    disableRetryOnRateLimit: true,
    fetch: async (_input, init) => {
      const raw = String(init?.body ?? "");
      let method = "batch", id: unknown = null;
      try {
        const body = JSON.parse(raw);
        if (!Array.isArray(body)) ({ method, id } = body);
      } catch {}
      return forwardRpc(url, raw, String(method), id);
    },
  });
}
