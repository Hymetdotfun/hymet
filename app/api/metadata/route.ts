import { NextRequest, NextResponse } from "next/server";
import { limitedBody, sameOrigin } from "../../../lib/http";
import { randomUUID, createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { validate, type Inputs } from "../../../lib/config";
import { socialLinks } from "../../../lib/socials";
import { validateArtwork } from "../../../lib/artwork";
import {
  metadataFetch,
  metadataJson,
  MetadataOperationError,
} from "../../../lib/metadata-service";
import { testNetworkRequested } from "../../../lib/app-network";
import { saveTestFile } from "../../../lib/test-network-files";
export const runtime = "nodejs";
const used = new Map<string, number>();
async function pin(
  file: Blob,
  name: string,
  operation: string,
  request: string,
) {
  const form = new FormData();
  form.set("file", file, name);
  form.set("network", "public");
  const r = await metadataFetch(
    "https://uploads.pinata.cloud/v3/files",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` },
      body: form,
    },
    operation,
    false,
    request,
  );
  const j = await metadataJson(r, operation);
  if (typeof j.data?.cid !== "string" || !/^[a-zA-Z0-9]+$/.test(j.data.cid))
    throw new MetadataOperationError(
      operation,
      "invalid CID response; upload completion UNKNOWN",
      502,
    );
  return j.data.cid as string;
}
export async function POST(req: NextRequest) {
  const request = randomUUID();
  let operation = "request validation";
  let imageUrl: string | undefined;
  let uri: string | undefined;
  const uploads = { image: "not-started", metadata: "not-started" };
  try {
    if (!sameOrigin(req))
      return new NextResponse("Origin denied", { status: 403 });
    const testFiles = testNetworkRequested();
    if (!testFiles && !process.env.PINATA_JWT)
      return NextResponse.json(
        {
          error:
            "Configure server-side PINATA_JWT for persistent metadata storage.",
        },
        { status: 503 },
      );
    if (Number(req.headers.get("content-length")) > 2 * 1024 * 1024)
      throw Error("Upload exceeds 2 MB");
    const body = await limitedBody(req, 2 * 1024 * 1024);
    const f = await new Response(body, {
      headers: { "Content-Type": req.headers.get("content-type") || "" },
    }).formData();
    const v = JSON.parse(String(f.get("details"))) as Inputs;
    validate(v);
    const image = f.get("image");
    if (
      !(image instanceof File) ||
      image.size > 1024 * 1024 ||
      image.size === 0 ||
      !["image/png", "image/jpeg", "image/gif"].includes(image.type)
    )
      throw Error("Choose a PNG, JPEG or GIF image up to 1 MB");
    const bytes = new Uint8Array(await image.arrayBuffer());
    validateArtwork(bytes, image.type);
    operation = "wallet message authorization";
    const wallet = new PublicKey(String(f.get("wallet")));
    const time = String(f.get("timestamp"));
    if (!/^\d{13}$/.test(time) || Math.abs(Date.now() - Number(time)) > 300000)
      throw new MetadataOperationError(operation, "authorization expired", 403);
    const message = `Authorize token metadata upload\nOrigin: ${req.headers.get("origin")}\nWallet: ${wallet.toBase58()}\nTimestamp: ${time}`;
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        wallet.toBuffer(),
      ]),
      format: "der",
      type: "spki",
    });
    if (
      !verify(
        null,
        Buffer.from(message),
        key,
        Buffer.from(String(f.get("signature")), "base64"),
      )
    )
      throw new MetadataOperationError(
        operation,
        "invalid wallet signature",
        403,
      );
    for (const [k, t] of used) if (Date.now() - t > 300000) used.delete(k);
    if (used.has(wallet.toBase58()))
      throw new MetadataOperationError(
        "local upload limit",
        "one upload per wallet per five minutes; check existing pins and reuse your prepared launch",
        429,
      );
    used.set(wallet.toBase58(), Date.now());
    if (testFiles) {
      // Test network: same validation and wallet authorization, but files stay on local disk (never public IPFS).
      operation = "test network metadata storage";
      imageUrl = await saveTestFile(bytes, image.type);
      const links = socialLinks(v);
      const metadata = { name: v.name, symbol: v.symbol, description: v.description, image: imageUrl, external_url: links.website || undefined, extensions: links };
      uri = await saveTestFile(new TextEncoder().encode(JSON.stringify(metadata)), "application/json");
      return NextResponse.json({ uri, imageUrl });
    }
    operation = "server gateway configuration";
    const gateway = process.env.IPFS_GATEWAY || "https://gateway.pinata.cloud";
    const gatewayUrl = new URL(gateway);
    if (
      gatewayUrl.protocol !== "https:" ||
      gatewayUrl.username ||
      gatewayUrl.password ||
      gatewayUrl.search ||
      gatewayUrl.hash ||
      gatewayUrl.pathname !== "/"
    )
      throw Error(
        "Gateway must be a public HTTPS origin without credentials, query parameters or paths",
      );
    operation = "Pinata image upload";
    uploads.image = "unknown";
    const imageCid = await pin(image, "token-image", operation, request);
    uploads.image = "confirmed";
    imageUrl = `${gateway.replace(/\/$/, "")}/ipfs/${imageCid}`;
    const links = socialLinks(v);
    const metadata = {
      name: v.name,
      symbol: v.symbol,
      description: v.description,
      image: imageUrl,
      external_url: links.website || undefined,
      extensions: links,
    };
    operation = "Pinata metadata upload";
    uploads.metadata = "unknown";
    const cid = await pin(
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      "metadata.json",
      operation,
      request,
    );
    uploads.metadata = "confirmed";
    uri = `${gateway.replace(/\/$/, "")}/ipfs/${cid}`;
    if (Buffer.byteLength(uri) > 200)
      throw Error("Metadata URI exceeds 200 bytes");
    operation = "metadata gateway verification";
    const check = await metadataFetch(
      uri,
      { method: "GET" },
      operation,
      true,
      request,
    );
    const resolved = await metadataJson(check, operation);
    if (
      resolved.name !== v.name ||
      resolved.image !== imageUrl ||
      resolved.external_url !== metadata.external_url ||
      (["website", "twitter", "telegram", "social"] as const).some(
        (key) => resolved.extensions?.[key] !== links[key],
      )
    )
      throw Error("Public metadata verification failed");
    operation = "image gateway verification";
    const img = await metadataFetch(
      imageUrl,
      { method: "HEAD" },
      operation,
      true,
      request,
    );
    await img.body?.cancel();
    console.info("Metadata diagnostic", {
      request,
      operation: "complete",
      uploads,
    });
    return NextResponse.json({ uri, imageUrl });
  } catch (e) {
    const failure = e instanceof MetadataOperationError ? e : undefined;
    const failedOperation = failure?.operation || operation;
    const message = failure
      ? failure.message
      : `${operation}: ${e instanceof Error ? e.message : "metadata preparation failed"}`;
    console.info("Metadata diagnostic", {
      request,
      operation: failedOperation,
      outcome: failure?.outcome || "validation failure",
      httpStatus: failure?.status || 400,
      upstreamStatus: failure?.upstreamStatus,
      code: failure?.code,
      uploads,
    });
    return NextResponse.json(
      {
        error: message,
        operation: failedOperation,
        request,
        code: failure?.code,
        upstreamStatus: failure?.upstreamStatus,
        uploads,
        uri,
        imageUrl,
      },
      {
        status: failure?.status || 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
