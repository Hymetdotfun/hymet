import { NextRequest, NextResponse } from "next/server";
import { limitedBody, sameOrigin, trustedHost } from "../../../lib/http";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { forwardRpc } from "../../../lib/rpc-forward";
import { APP_NETWORK, rpcProxyEnabled, serverRpcUrl } from "../../../lib/app-network";
const allowed = new Set([
  "getGenesisHash",
  "getAccountInfo",
  "getMultipleAccounts",
  "getLatestBlockhash",
  "getBalance",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "simulateTransaction",
  "sendTransaction",
  "getSignatureStatuses",
  "getBlockHeight",
  "getEpochInfo",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getSlot",
  "getTransaction",
]);
export async function POST(req: NextRequest) {
  try {
    if (!trustedHost(req))
      return new NextResponse("Loopback or configured public host required", { status: 403 });
    // Only this site's pages may spend the private RPC quota; browsers always send Origin on these POSTs.
    if (!sameOrigin(req))
      return new NextResponse("Origin denied", { status: 403 });
    const network = req.nextUrl.searchParams.get("network") || APP_NETWORK;
    if (network !== APP_NETWORK)
      return new NextResponse("Mainnet Beta only", { status: 400 });
    if (!rpcProxyEnabled())
      return new NextResponse("Mainnet disabled", { status: 403 });
    const raw = new TextDecoder().decode(await limitedBody(req, 128000));
    if (raw.length > 128000)
      return new NextResponse("Too large", { status: 413 });
    const body = JSON.parse(raw);
    if (
      body.method === "sendTransaction" &&
      process.env.HYPE_DEV_READ_ONLY === "true"
    )
      return new NextResponse(
        "HYPE development is read-only; broadcasting is disabled",
        { status: 403 },
      );
    if (Array.isArray(body) || !allowed.has(body.method))
      return new NextResponse("RPC method denied", { status: 400 });
    if (body.method === "getTokenAccountsByOwner") {
      const filter = body.params?.[1];
      let ownerValid = false;
      try {
        ownerValid =
          typeof body.params?.[0] === "string" &&
          new PublicKey(body.params[0]).toBase58() === body.params[0];
      } catch {
        /* Reject malformed owners before forwarding. */
      }
      if (
        !ownerValid ||
        !filter ||
        Object.keys(filter).length !== 1 ||
        filter.programId !== TOKEN_2022_PROGRAM_ID.toBase58()
      )
        return new NextResponse(
          "Only bounded-response Token-2022 owner discovery is allowed",
          { status: 400 },
        );
    }
    if (
      body.method === "getMultipleAccounts" &&
      (!Array.isArray(body.params?.[0]) || body.params[0].length > 100)
    )
      return new NextResponse("Too many accounts", { status: 400 });
    const url = serverRpcUrl();
    return forwardRpc(url, raw, body.method, body.id);
  } catch {
    return NextResponse.json(
      { error: { code: -32000, message: "RPC request failed or timed out" } },
      { status: 502 },
    );
  }
}
