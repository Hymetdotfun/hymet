import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chain = vi.hoisted(() => ({ ready: false, calls: 0 }));
vi.mock("../lib/distributor-readiness", () => ({
  verifiedDistributor: async () => {
    chain.calls++;
    return chain.ready ? { program: {}, connection: {}, config: {} } : null;
  },
}));
import { servedAllocationPolicy } from "../lib/allocation-policy";

const flags = { HYMET_LAUNCH_MODE: "distributor", HYMET_DISTRIBUTOR_VERIFIED: "true", HYMET_DISTRIBUTOR_APP_VERIFIED: "true", HYMET_HOLDER_PAYOUTS_VERIFIED: "true" };
const localnet = { NEXT_PUBLIC_HYMET_TEST_NETWORK: "localnet", HYMET_TEST_NETWORK: "localnet", NEXT_PUBLIC_HYMET_TEST_GENESIS: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY", HYMET_TEST_RPC_URL: "http://127.0.0.1:19995", NEXT_PUBLIC_ENABLE_MAINNET: "false", ENABLE_MAINNET: "false", VERCEL: "", VERCEL_ENV: "" };
const stub = (env: Record<string, string>) => Object.entries(env).forEach(([k, v]) => vi.stubEnv(k, v));

beforeEach(() => Object.assign(chain, { ready: false, calls: 0 }));
afterEach(() => vi.unstubAllEnvs());

describe("served launch allocation policy", () => {
  it("keeps the Mainnet policy flag-only and unchanged (no chain probe)", async () => {
    stub({ NEXT_PUBLIC_HYMET_TEST_NETWORK: "" });
    expect(await servedAllocationPolicy()).toMatchObject({ min: 100, max: 100, default: 100, holderAllocationsEnabled: false, launchMode: "native-split" });
    stub(flags);
    expect(await servedAllocationPolicy()).toMatchObject({ min: 0, max: 100, step: 1, default: 100, holderAllocationsEnabled: true });
    expect(chain.calls).toBe(0);
  });

  it("on localnet offers 0..100 only when the flags are set AND the distributor is verified on-chain", async () => {
    stub({ ...localnet, ...flags });
    expect(await servedAllocationPolicy()).toMatchObject({ min: 100, max: 100, holderAllocationsEnabled: false });
    chain.ready = true;
    expect(await servedAllocationPolicy()).toMatchObject({ min: 0, max: 100, step: 1, platformBps: 2000, launchMode: "distributor", holderAllocationsEnabled: true });
  });

  it("on localnet stays 100/0 without the flags, even with a ready distributor", async () => {
    stub(localnet);
    chain.ready = true;
    expect(await servedAllocationPolicy()).toMatchObject({ min: 100, max: 100, holderAllocationsEnabled: false, launchMode: "native-split" });
    expect(chain.calls).toBe(0);
  });
});
