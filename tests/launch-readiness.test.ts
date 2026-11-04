import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { describeSendFailure } from "../lib/keeper-rpc";

const h = vi.hoisted(() => ({ deployment: vi.fn(), authorities: vi.fn() }));
vi.mock("../lib/distributor-engine", () => ({ verifyDistributorDeployment: h.deployment, verifyConfiguredDistributorAuthorities: h.authorities }));
vi.mock("../lib/transactions", () => ({ configuredPlatformFeeRecipient: () => new PublicKey("7sAoyG3ZdewKrZKLzU8VTpfzNh6YuJKQAgnWjgjSqPEs") }));
vi.mock("@solana/web3.js", async (original) => {
  const actual = await original<typeof import("@solana/web3.js")>();
  class Connection {
    getGenesisHash = async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    getAccountInfo = async () => ({ executable: true });
  }
  return { ...actual, Connection };
});

describe("keeper send failures", () => {
  it("keeps the RPC error and last logs that the default message hides", async () => {
    const error = Object.assign(Error("Simulation failed. \nMessage: Transaction simulation failed. \nLogs: \n[]."), {
      transactionError: { message: "Transaction simulation failed: Blockhash not found" },
      getLogs: async () => ["a", "b", "c", "d", "e"],
    });
    const text = await describeSendFailure(error, {}, "fund epoch 0");
    expect(text).toContain("fund epoch 0 send failed: Simulation failed.");
    expect(text).toContain("Blockhash not found");
    expect(text).toContain("logs: b | c | d | e");
    expect(text).not.toContain("\n");
  });

  it("still reports when logs are unavailable or the error is plain", async () => {
    const noLogs = Object.assign(Error("boom"), { getLogs: async () => { throw Error("no logs"); } });
    expect(await describeSendFailure(noLogs, {}, "pay")).toBe("pay send failed: boom");
    expect(await describeSendFailure("text", {}, "pay")).toBe("pay send failed: text");
    expect((await describeSendFailure(Error("x".repeat(900)), {}, "pay")).length).toBeLessThanOrEqual(600);
  });
});

describe("verified distributor reuse", () => {
  const flags = {
    HYMET_LAUNCH_MODE: "distributor", HYMET_DISTRIBUTOR_VERIFIED: "true", HYMET_DISTRIBUTOR_APP_VERIFIED: "true",
    HYMET_DISTRIBUTOR_PROGRAM_ID: "9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px", MAINNET_RPC_URL: "https://rpc.example", NEXT_PUBLIC_HYMET_TEST_NETWORK: "",
  };
  beforeEach(() => {
    vi.resetModules();
    h.deployment.mockReset().mockResolvedValue(new PublicKey("5QMrhkg36hnJVBubARNLrL8vPaCb9koRYLeffVc8GNHG"));
    h.authorities.mockReset().mockResolvedValue(undefined);
    for (const [key, value] of Object.entries(flags)) vi.stubEnv(key, value);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
  const load = async () => (await import("../lib/distributor-readiness")).verifiedDistributor;

  it("reuses a positive result briefly, then checks the chain again", async () => {
    vi.useFakeTimers();
    const verifiedDistributor = await load();
    expect(await verifiedDistributor()).not.toBeNull();
    expect(await verifiedDistributor()).not.toBeNull();
    expect(h.deployment).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    await verifiedDistributor();
    expect(h.deployment).toHaveBeenCalledTimes(2);
  });

  it("checks the owner flags on every call, even with a cached result", async () => {
    const verifiedDistributor = await load();
    expect(await verifiedDistributor()).not.toBeNull();
    vi.stubEnv("HYMET_DISTRIBUTOR_VERIFIED", "false");
    expect(await verifiedDistributor()).toBeNull();
  });

  it("does not reuse a failure or a different program", async () => {
    const verifiedDistributor = await load();
    h.deployment.mockRejectedValueOnce(Error("429"));
    expect(await verifiedDistributor()).toBeNull();
    expect(await verifiedDistributor()).not.toBeNull();
    expect(h.deployment).toHaveBeenCalledTimes(2);
    vi.stubEnv("HYMET_DISTRIBUTOR_PROGRAM_ID", "H8PvVTwq6C9ZUtppfrFnp93rZasbbYbKfHMEeFSMy8ws");
    await verifiedDistributor();
    expect(h.deployment).toHaveBeenCalledTimes(3);
  });
});
