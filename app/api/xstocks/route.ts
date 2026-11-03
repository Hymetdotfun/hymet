import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { limitedBody, sameOrigin, trustedHost } from "../../../lib/http";
import { officialXstocks } from "../../../lib/xstocks-registry";
import { verifyXstocks } from "../../../lib/xstocks-chain";

export async function GET(req: NextRequest) {
  if (
    !trustedHost(req) ||
    req.headers.get("sec-fetch-site") === "cross-site" ||
    (req.headers.get("origin") && !sameOrigin(req))
  )
    return new NextResponse("Loopback same-origin request required", {
      status: 403,
    });
  if (process.env.ENABLE_MAINNET !== "true")
    return new NextResponse("Mainnet disabled", { status: 403 });
  try {
    const registry = await officialXstocks();
    const c = new Connection(
      process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com",
      {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
        fetch: async (url, init) => {
          const r = await fetch(url, {
            ...init,
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(20_000),
          });
          if (!r.ok) throw Error("RPC unavailable");
          return new Response(await limitedBody(r, 4 * 1024 * 1024), {
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    );
    const assets = await verifyXstocks(c, registry.assets);
    return NextResponse.json(
      {
        source: "https://api.xstocks.fi/api/v2/public/assets",
        fetchedAt: registry.fetchedAt,
        verifiedAt: Date.now(),
        assets,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // No stale registry fallback, upstream URLs, credentials or account errors exposed.
    return NextResponse.json(
      {
        error:
          "Official registry or Mainnet verification unavailable. xStocks launches remain disabled.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
