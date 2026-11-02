import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVNET_GENESIS, DEVNET_RPC_URL, MAINNET_GENESIS, activeNetworkLabel, claimNetworkLabel, expectedGenesis, mainnetTransactionsEnabled, rpcProxyEnabled, serverRpcUrl, testNetworkActive, testNetworkProblem } from "../lib/app-network";

const LOCAL_GENESIS = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
const valid = { NEXT_PUBLIC_HYMET_TEST_NETWORK: "localnet", HYMET_TEST_NETWORK: "localnet", NEXT_PUBLIC_HYMET_TEST_GENESIS: LOCAL_GENESIS, HYMET_TEST_RPC_URL: "http://127.0.0.1:19995", NEXT_PUBLIC_ENABLE_MAINNET: "false", ENABLE_MAINNET: "false", VERCEL: "", VERCEL_ENV: "", MAINNET_RPC_URL: "https://mainnet.example" };
const stub = (env: Record<string, string>) => Object.entries(env).forEach(([k, v]) => vi.stubEnv(k, v));

afterEach(() => vi.unstubAllEnvs());

describe("guarded local test network", () => {
  it("is off by default: Mainnet genesis, Mainnet RPC and the Mainnet switches", () => {
    stub({ NEXT_PUBLIC_HYMET_TEST_NETWORK: "", NEXT_PUBLIC_ENABLE_MAINNET: "true", ENABLE_MAINNET: "true", MAINNET_RPC_URL: "https://mainnet.example" });
    expect(testNetworkActive()).toBe(false);
    expect(expectedGenesis()).toBe(MAINNET_GENESIS);
    expect(serverRpcUrl()).toBe("https://mainnet.example");
    expect(mainnetTransactionsEnabled()).toBe(true);
    vi.stubEnv("ENABLE_MAINNET", "false");
    expect(mainnetTransactionsEnabled()).toBe(false);
    expect(rpcProxyEnabled()).toBe(false);
  });

  it("pins every RPC and genesis check to the loopback validator when correctly configured", () => {
    stub(valid);
    expect(testNetworkProblem()).toBeNull();
    expect(claimNetworkLabel("mainnet-beta")).toBe("Localnet");
    expect(expectedGenesis()).toBe(LOCAL_GENESIS);
    expect(serverRpcUrl()).toBe("http://127.0.0.1:19995");
    expect(serverRpcUrl()).not.toBe(process.env.MAINNET_RPC_URL);
    expect(mainnetTransactionsEnabled()).toBe(true);
    expect(rpcProxyEnabled()).toBe(true);
  });

  it.each([
    ["Mainnet browser switch on", { NEXT_PUBLIC_ENABLE_MAINNET: "true" }, /Mainnet switches/],
    ["Mainnet server switch on", { ENABLE_MAINNET: "true" }, /Mainnet switches/],
    ["Mainnet genesis", { NEXT_PUBLIC_HYMET_TEST_GENESIS: MAINNET_GENESIS }, /never Mainnet/],
    ["missing genesis", { NEXT_PUBLIC_HYMET_TEST_GENESIS: "" }, /GENESIS/],
    ["public RPC", { HYMET_TEST_RPC_URL: "https://api.mainnet-beta.solana.com" }, /loopback/],
    ["Devnet RPC", { HYMET_TEST_RPC_URL: "https://api.devnet.solana.com" }, /loopback/],
    ["Vercel", { VERCEL: "1" }, /Vercel/],
    ["Vercel env", { VERCEL_ENV: "preview" }, /Vercel/],
    ["server flag missing", { HYMET_TEST_NETWORK: "" }, /HYMET_TEST_NETWORK/],
    ["unknown network", { NEXT_PUBLIC_HYMET_TEST_NETWORK: "testnet" }, /localnet/],
  ])("fails closed (no transactions, no Mainnet fallback) with %s", (_name, change, reason) => {
    stub({ ...valid, ...change });
    expect(testNetworkProblem()).toMatch(reason);
    expect(claimNetworkLabel("mainnet-beta")).toBe("Localnet unavailable · claims blocked");
    expect(testNetworkActive()).toBe(false);
    expect(mainnetTransactionsEnabled()).toBe(false);
    expect(rpcProxyEnabled()).toBe(false);
    expect(() => serverRpcUrl()).toThrow(/Test network misconfigured/);
    expect(() => expectedGenesis()).toThrow(/Test network misconfigured/);
  });
});

describe("guarded Devnet test network", () => {
  const TEST_HYPE = "AxDgHs54im8aCMLFxwfXz6f6quXFUEkKeQMTNZ8CUHvz";
  const devnet = { ...valid, NEXT_PUBLIC_HYMET_TEST_NETWORK: "devnet", HYMET_TEST_NETWORK: "devnet", NEXT_PUBLIC_HYMET_TEST_GENESIS: DEVNET_GENESIS, HYMET_TEST_RPC_URL: DEVNET_RPC_URL, NEXT_PUBLIC_HYMET_TEST_HYPE_MINT: TEST_HYPE };

  it("pins every RPC and genesis check to public Devnet when correctly configured", () => {
    stub(devnet);
    expect(testNetworkProblem()).toBeNull();
    expect(claimNetworkLabel("mainnet-beta")).toBe("Devnet");
    expect(activeNetworkLabel()).toBe("Devnet test network (devnet)");
    expect(expectedGenesis()).toBe(DEVNET_GENESIS);
    expect(serverRpcUrl()).toBe(DEVNET_RPC_URL);
    expect(mainnetTransactionsEnabled()).toBe(true);
  });

  it.each([
    ["Mainnet RPC", { HYMET_TEST_RPC_URL: "https://api.mainnet-beta.solana.com" }, /api\.devnet/],
    ["loopback RPC", { HYMET_TEST_RPC_URL: "http://127.0.0.1:19995" }, /api\.devnet/],
    ["local genesis", { NEXT_PUBLIC_HYMET_TEST_GENESIS: LOCAL_GENESIS }, /Devnet genesis/],
    ["Mainnet genesis", { NEXT_PUBLIC_HYMET_TEST_GENESIS: MAINNET_GENESIS }, /never Mainnet/],
    ["Mainnet HYPE", { NEXT_PUBLIC_HYMET_TEST_HYPE_MINT: "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g" }, /never Mainnet HYPE/],
    ["missing test HYPE", { NEXT_PUBLIC_HYMET_TEST_HYPE_MINT: "" }, /TEST_HYPE_MINT/],
    ["Mainnet switch on", { ENABLE_MAINNET: "true" }, /Mainnet switches/],
    ["Vercel", { VERCEL: "1" }, /Vercel/],
    ["server flag mismatch", { HYMET_TEST_NETWORK: "localnet" }, /HYMET_TEST_NETWORK/],
  ])("fails closed with %s", (_name, change, reason) => {
    stub({ ...devnet, ...change });
    expect(testNetworkProblem()).toMatch(reason);
    expect(claimNetworkLabel("mainnet-beta")).toBe("Devnet unavailable · claims blocked");
    expect(mainnetTransactionsEnabled()).toBe(false);
    expect(() => serverRpcUrl()).toThrow(/Test network misconfigured/);
  });
});
