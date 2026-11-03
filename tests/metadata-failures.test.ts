import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import { createPrivateKey, sign } from "node:crypto";
import { defaults } from "../lib/config";
import { POST } from "../app/api/metadata/route";
import { metadataFetch } from "../lib/metadata-service";
import {
  uploadAuthorizedMetadata,
  metadataPreparationError,
} from "../lib/metadata-preparation";
import { png500 } from "./fixtures/png-500";
// These tests model open launches; the closed state is covered separately.
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
  vi.stubEnv("ENABLE_MAINNET", "true");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function request(mode = "valid", wallet = Keypair.generate()) {
  vi.stubEnv("PINATA_JWT", "synthetic-credential-never-log");
  vi.stubEnv("IPFS_GATEWAY", "https://example.com");
  const timestamp = String(Date.now() - (mode === "expired" ? 400000 : 0));
  const message = `Authorize token metadata upload\nOrigin: http://localhost\nWallet: ${wallet.publicKey.toBase58()}\nTimestamp: ${timestamp}`;
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(wallet.secretKey.subarray(0, 32)),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const f = new FormData();
  f.set(
    "details",
    JSON.stringify({ ...defaults, name: "Test", symbol: "TEST" }),
  );
  f.set(
    "image",
    new Blob([png500()], {
      type: "image/png",
    }),
    "logo.png",
  );
  f.set("wallet", wallet.publicKey.toBase58());
  f.set("timestamp", timestamp);
  f.set(
    "signature",
    mode === "invalid"
      ? Buffer.alloc(64).toString("base64")
      : sign(null, Buffer.from(message), key).toString("base64"),
  );
  return new NextRequest("http://localhost/api/metadata", {
    method: "POST",
    headers: { origin: "http://localhost" },
    body: f,
  });
}
const pin = () => Response.json({ data: { cid: "bafytest" } });
const json = () =>
  Response.json({
    name: "Test",
    image: "https://example.com/ipfs/bafytest",
    extensions: { website: "", twitter: "", telegram: "", social: "" },
  });
it.each(["expired", "invalid"])(
  "rejects %s authorization before any upload",
  async (mode) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const r = await POST(request(mode));
    expect(r.status).toBe(403);
    expect((await r.json()).operation).toBe("wallet message authorization");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([401, 429])(
  "reports Pinata HTTP %s without retry or RPC classification",
  async (status) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("secret-upstream-body", { status }));
    vi.stubGlobal("fetch", fetcher);
    const r = await POST(request());
    const data = await r.json();
    expect(data.operation).toBe("Pinata image upload");
    expect(data.upstreamStatus).toBe(status);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(data)).not.toMatch(
      /RPC|secret-upstream-body|synthetic-credential/,
    );
  },
);
it("retains unknown upload completion on Pinata timeout and never repeats POST", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValue(new DOMException("timed out", "TimeoutError"));
  vi.stubGlobal("fetch", fetcher);
  const r = await POST(request());
  expect(r.status).toBe(504);
  const data = await r.json();
  expect(data.uploads).toEqual({ image: "unknown", metadata: "not-started" });
  expect(data.error).toContain("timeout");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("keeps the confirmed image receipt when metadata upload times out", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(pin())
    .mockRejectedValue(new DOMException("timeout", "TimeoutError"));
  vi.stubGlobal("fetch", fetcher);
  const r = await POST(request());
  const data = await r.json();
  expect(data.operation).toBe("Pinata metadata upload");
  expect(data.imageUrl).toBe("https://example.com/ipfs/bafytest");
  expect(data.uploads).toEqual({ image: "confirmed", metadata: "unknown" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("reports local wallet rate limiting separately and preserves the replay guard after failure", async () => {
  const wallet = Keypair.generate();
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  await POST(request("valid", wallet));
  const r = await POST(request("valid", wallet));
  expect(r.status).toBe(429);
  expect((await r.json()).operation).toBe("local upload limit");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("preserves confirmed upload URI when gateway verification times out; uploads occur once", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(pin())
    .mockResolvedValueOnce(pin())
    .mockRejectedValue(new DOMException("timeout", "TimeoutError"));
  vi.stubGlobal("fetch", fetcher);
  const r = await POST(request());
  expect(r.status).toBe(504);
  const data = await r.json();
  expect(data.operation).toBe("metadata gateway verification");
  expect(data.uri).toBe("https://example.com/ipfs/bafytest");
  expect(data.uploads).toEqual({ image: "confirmed", metadata: "confirmed" });
  expect(
    fetcher.mock.calls.filter((c) => c[1]?.method === "POST"),
  ).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(5);
});
it("retains the JSON receipt when only image gateway availability fails", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(pin())
    .mockResolvedValueOnce(pin())
    .mockResolvedValueOnce(json())
    .mockResolvedValue(new Response(null, { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  const r = await POST(request());
  const data = await r.json();
  expect(data.operation).toBe("image gateway verification");
  expect(data.uri).toBeTruthy();
  expect(data.uploads.metadata).toBe("confirmed");
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it("rejects a missing CID instead of accepting the coerced string undefined", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: {} }));
  vi.stubGlobal("fetch", fetcher);
  const r = await POST(request());
  expect(r.status).toBe(502);
  expect((await r.json()).error).toContain("invalid CID");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("retries gateway transport failure only and logs no secrets", async () => {
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = Object.assign(new TypeError("fetch failed with SECRET"), {
    cause: { code: "UND_ERR_SOCKET" },
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(error)
    .mockResolvedValue(new Response("ok"));
  const sleep = vi.fn(async () => {});
  const r = await metadataFetch(
    "https://example.com/ipfs/bafytest",
    { method: "GET" },
    "metadata gateway verification",
    true,
    "request",
    fetcher,
    sleep,
  );
  expect(r.ok).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(500);
  expect(JSON.stringify(logs.mock.calls)).toContain("UND_ERR_SOCKET");
  expect(JSON.stringify(logs.mock.calls)).not.toContain("SECRET");
});
it("respects Retry-After on gateway 429 without replaying uploads", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "retry-after": "2" } }),
    )
    .mockResolvedValue(new Response("ok"));
  const sleep = vi.fn(async () => {});
  await metadataFetch(
    "https://example.com/ipfs/test",
    { method: "HEAD" },
    "image gateway verification",
    true,
    "request",
    fetcher,
    sleep,
  );
  expect(sleep).toHaveBeenCalledWith(2000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("browser transport failure remains UNKNOWN and is never automatically retried", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValue(TypeError("fetch failed"));
  await expect(
    uploadAuthorizedMetadata(new FormData(), fetcher),
  ).rejects.toThrow("upload completion UNKNOWN");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("browser preserves known metadata URI and HTTP status without calling it RPC failure", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        error: "image gateway verification: timeout",
        uri: "https://example.com/ipfs/bafytest",
      },
      { status: 504 },
    ),
  );
  await expect(
    uploadAuthorizedMetadata(new FormData(), fetcher),
  ).rejects.toThrow("Pinata confirmed metadata upload");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    metadataPreparationError(
      Error(
        "Pinata image upload: service rejected request (upstream HTTP 429)",
      ),
    ),
  ).toContain("HTTP 429");
  expect(
    metadataPreparationError(Error("User rejected (4001)"), true),
  ).toContain("message approval rejected");
});
it("non-JSON server errors preserve HTTP status and uncertain completion", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("unavailable", { status: 503 }));
  await expect(
    uploadAuthorizedMetadata(new FormData(), fetcher),
  ).rejects.toThrow("HTTP 503");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("preserves timeout classification when upload response headers arrived but its body fails", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new DOMException("timeout", "TimeoutError"));
      },
    }),
  );
  const fetcher = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetcher);
  const r = await POST(request());
  expect(r.status).toBe(504);
  const data = await r.json();
  expect(data.operation).toBe("Pinata image upload");
  expect(data.uploads.image).toBe("unknown");
  expect(data.error).toContain("timeout reading response");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
