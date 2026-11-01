import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { localRequest, sameOrigin } from "../../../../lib/http";
import { officialXstocks } from "../../../../lib/xstocks-registry";
import { issuerLogo } from "../../../../lib/xstocks-logo";

export async function GET(req: NextRequest) {
  if (
    !localRequest(req) ||
    req.headers.get("sec-fetch-site") === "cross-site" ||
    (req.headers.get("origin") && !sameOrigin(req))
  )
    return new NextResponse("Origin denied", { status: 403 });
  if (process.env.ENABLE_MAINNET !== "true")
    return new NextResponse("Mainnet disabled", { status: 403 });
  try {
    const mint = req.nextUrl.searchParams.get("mint") || "";
    if (new PublicKey(mint).toBase58() !== mint) throw Error("Invalid mint");
    const asset = (await officialXstocks()).assets.find((a) => a.mint === mint);
    if (!asset?.icon) return new NextResponse(null, { status: 404 });
    const logo = await issuerLogo(asset.icon);
    return new NextResponse(new Uint8Array(logo.bytes), {
      headers: {
        "Content-Type": logo.type,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
