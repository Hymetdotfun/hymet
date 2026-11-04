import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createPrivateKey, sign } from "node:crypto";
import { Keypair, SystemProgram, Connection } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { HYPE_MINT } from "../lib/quote-assets";
import { launchAuthorizationMessage } from "../lib/launch-authorization";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { buildPlan } from "../lib/transactions";
import { POST } from "../app/api/metadata/route";
import { defaults } from "../lib/config";
import { verifyMetadataBytes } from "../lib/metadata";
import { png500 } from "./fixtures/png-500";
// These tests model open launches; the closed state is covered separately.
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
  vi.stubEnv("ENABLE_MAINNET", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("requires persistent storage credentials and denies foreign origins", async () => {
  vi.stubEnv("PINATA_JWT", "");
  expect(
    (
      await POST(
        new NextRequest("http://localhost/api/metadata", {
          method: "POST",
          headers: { origin: "http://localhost" },
        }),
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await POST(
        new NextRequest("http://localhost/api/metadata", {
          method: "POST",
          headers: { origin: "https://foreign.example" },
        }),
      )
    ).status,
  ).toBe(403);
});
it.each([
  { website: "", twitter: "", telegram: "", social: "" },
  {
    website: "https://example.org/project",
    twitter: "https://x.com/project",
    telegram: "https://t.me/project",
    social: "",
  },
  { website: "", twitter: "https://twitter.com/project", telegram: "", social: "" },
])(
  "uploads optional links and uses their JSON URI in the SDK pool transaction (provider/RPC mocked): %j",
  async (links) => {
    vi.stubEnv("PINATA_JWT", "unit-test-placeholder");
    vi.stubEnv("IPFS_GATEWAY", "https://example.com");
    const wallet = Keypair.generate(),
      issuedAt = new Date().toISOString(),
      nonce = "00000000-0000-4000-8000-000000000000";
    const message = launchAuthorizationMessage({ origin: "http://localhost", wallet: wallet.publicKey.toBase58(), name: "Trajectory", ticker: "TRJ", nonce, issuedAt });
    const key = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.from(wallet.secretKey.subarray(0, 32)),
      ]),
      format: "der",
      type: "pkcs8",
    });
    const form = new FormData();
    form.set(
      "details",
      JSON.stringify({
        ...defaults,
        name: "Trajectory",
        symbol: "TRJ",
        ...links,
      }),
    );
    form.set(
      "image",
      new Blob([png500()], {
        type: "image/png",
      }),
      "logo.png",
    );
    form.set("wallet", wallet.publicKey.toBase58());
    form.set("issuedAt", issuedAt);
    form.set("nonce", nonce);
    form.set(
      "signature",
      sign(null, Buffer.from(message), key).toString("base64"),
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { cid: "bafyimage" } }))
      .mockResolvedValueOnce(Response.json({ data: { cid: "bafymetadata" } }))
      .mockResolvedValueOnce(
        Response.json({
          name: "Trajectory",
          image: "https://example.com/ipfs/bafyimage",
          external_url: links.website || undefined,
          extensions: links,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const r = await POST(
      new NextRequest("http://localhost/api/metadata", {
        method: "POST",
        headers: { origin: "http://localhost" },
        body: form,
      }),
    );
    expect(r.status).toBe(200);
    const uploaded = await r.json();
    expect(uploaded).toEqual({
      uri: "https://example.com/ipfs/bafymetadata",
      imageUrl: "https://example.com/ipfs/bafyimage",
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const jsonForm = fetcher.mock.calls[1][1].body as FormData;
    const jsonFile = jsonForm.get("file") as File;
    const metadata = JSON.parse(await jsonFile.text());
    expect(metadata).toMatchObject({
      name: "Trajectory",
      symbol: "TRJ",
      image: uploaded.imageUrl,
      extensions: links,
    });
    if (links.website) expect(metadata.external_url).toBe(links.website);
    else expect(metadata).not.toHaveProperty("external_url");
    expect(jsonFile.type).toBe("application/json");
    // Production buildPlan is exercised with deterministic read-only RPC fixtures.
    const c = new Connection("http://localhost:8899");
    const mintData = Buffer.alloc(MintLayout.span);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: SystemProgram.programId,
        supply: 0n,
        decimals: 9,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: SystemProgram.programId,
      },
      mintData,
    );
    vi.spyOn(c, "getGenesisHash").mockResolvedValue(
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    );
    vi.spyOn(c, "getAccountInfo").mockImplementation(async (address) =>
      address.equals(HYPE_MINT)
        ? {
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            lamports: 10000000,
            data: mintData,
            rentEpoch: 0,
          }
        : {
            owner: SystemProgram.programId,
            executable: true,
            lamports: 1,
            data: Buffer.alloc(0),
            rentEpoch: 0,
          },
    );
    vi.spyOn(c, "getEpochInfo").mockResolvedValue({
      epoch: 1,
      slotIndex: 1,
      slotsInEpoch: 1000,
      absoluteSlot: 1001,
    });
    vi.spyOn(c, "getLatestBlockhash").mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1000,
    });
    vi.spyOn(c, "getFeeForMessage").mockResolvedValue({
      context: { slot: 1 },
      value: 5000,
    });
    vi.spyOn(c, "getMinimumBalanceForRentExemption").mockResolvedValue(10000);
    vi.spyOn(c, "getBalance").mockResolvedValue(1000000000);
    const send = vi
      .spyOn(c, "sendRawTransaction")
      .mockRejectedValue(Error("Broadcast prohibited in this test"));
    vi.stubEnv(
      "HYMET_PLATFORM_FEE_RECIPIENT",
      Keypair.generate().publicKey.toBase58(),
    );
    const plan = await buildPlan(
      c,
      { ...defaults, name: "Trajectory", symbol: "TRJ", ...links },
      wallet.publicKey,
      "devnet",
      uploaded.uri,
    );
    const sdk = new DynamicBondingCurveClient(c);
    const poolIx = plan.steps[1].tx.instructions.find((ix) =>
      ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
    )!;
    const decoded = new BorshInstructionCoder(sdk.program.idl).decode(
      poolIx.data,
    )!;
    expect(decoded.name).toBe("initializeVirtualPoolWithSplToken");
    expect((decoded.data as { params: { uri: string } }).params.uri).toBe(
      uploaded.uri,
    );
    expect(plan.uri).toBe(uploaded.uri);
    expect(plan.uri).not.toBe(uploaded.imageUrl);
    expect(send).not.toHaveBeenCalled();
  },
);
it("verifies metadata content and immutability from its on-chain Borsh prefix", () => {
  const mint = Keypair.generate().publicKey;
  const str = (s: string) => {
    const b = Buffer.from(s),
      n = Buffer.alloc(4);
    n.writeUInt32LE(b.length);
    return Buffer.concat([n, b]);
  };
  const data = Buffer.concat([
    Buffer.from([4]),
    SystemProgram.programId.toBuffer(),
    mint.toBuffer(),
    str("Trajectory"),
    str("TRJ"),
    str("https://example.com/meta"),
    Buffer.from([0, 0, 0, 0, 0]),
  ]);
  expect(() =>
    verifyMetadataBytes(
      data,
      mint,
      "Trajectory",
      "TRJ",
      "https://example.com/meta",
    ),
  ).not.toThrow();
  data[data.length - 1] = 1;
  expect(() =>
    verifyMetadataBytes(
      data,
      mint,
      "Trajectory",
      "TRJ",
      "https://example.com/meta",
    ),
  ).toThrow("immutability");
});
it("refuses uploads while launches are disabled, before touching storage", async () => {
  vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "false");
  vi.stubEnv("ENABLE_MAINNET", "false");
  vi.stubEnv("PINATA_JWT", "unit-test-placeholder");
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const r = await POST(new NextRequest("http://localhost/api/metadata", { method: "POST", headers: { origin: "http://localhost" } }));
  expect(r.status).toBe(403);
  expect(await r.json()).toEqual({ error: "Launches are not open yet" });
  expect(fetchSpy).not.toHaveBeenCalled();
});
