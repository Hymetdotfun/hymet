import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { confirmedLaunchDestination } from "../lib/confirmed-launch-route";

describe("confirmed launch navigation", () => {
  it("routes to the actual verified and registered mint", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    expect(confirmedLaunchDestination(mint, true, true)).toBe(
      `/token/${encodeURIComponent(mint)}`,
    );
  });

  it("does not navigate before on-chain confirmation or registry persistence", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    expect(confirmedLaunchDestination(mint, false, true)).toBeNull();
    expect(confirmedLaunchDestination(mint, true, false)).toBeNull();
  });

  it("rejects invalid or non-canonical mint addresses", () => {
    expect(confirmedLaunchDestination("not-a-mint", true, true)).toBeNull();
    expect(confirmedLaunchDestination("1", true, true)).toBeNull();
  });
});
