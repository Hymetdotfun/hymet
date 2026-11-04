import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ paid: 0, failHolderQuery: false }));
vi.mock("../lib/db", () => ({
  databaseConfigured: () => Boolean(process.env.DATABASE_URL),
  query: async (sql: string) => {
    if (sql.includes("claims")) {
      if (h.failHolderQuery) throw Error("relation unavailable");
      return { rows: [{ count: h.paid, last_at: h.paid ? new Date("2026-11-05T00:00:00Z") : null }] };
    }
    return { rows: [{}] };
  },
}));
import { GET } from "../app/api/health/route";

const PROGRAM = "9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px";
const configured = {
  DATABASE_URL: "postgres://localhost/test",
  HYMET_DISTRIBUTOR_PROGRAM_ID: PROGRAM,
  HYMET_LAUNCH_MODE: "distributor",
  HYMET_DISTRIBUTOR_VERIFIED: "true",
  HYMET_DISTRIBUTOR_APP_VERIFIED: "true",
  HYMET_HOLDER_PAYOUTS_VERIFIED: "true",
  NEXT_PUBLIC_ENABLE_MAINNET: "false",
  ENABLE_MAINNET: "false",
  HYPE_DEV_READ_ONLY: "true",
};
const body = async () => (await GET()).json();

describe("/api/health", () => {
  beforeEach(() => {
    h.paid = 0;
    h.failHolderQuery = false;
    vi.stubEnv("NEXT_PUBLIC_HYMET_TEST_NETWORK", "");
    for (const [key, value] of Object.entries(configured)) vi.stubEnv(key, value);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reports holder rewards as configured, not verified, with launches closed", async () => {
    expect(await body()).toMatchObject({
      status: "ok",
      launchesEnabled: false,
      mainnetBroadcasts: false,
      launchMode: "distributor",
      holderRewards: { configured: true, mainnetPayoutVerified: false, mainnetPayoutsIndexed: 0, lastMainnetPayoutAt: null },
    });
  });

  it("reports a Mainnet payout as verified only with a recorded payout", async () => {
    h.paid = 3;
    expect((await body()).holderRewards).toMatchObject({ configured: true, mainnetPayoutVerified: true, mainnetPayoutsIndexed: 3 });
  });

  it("never counts test-network payouts as Mainnet payouts", async () => {
    h.paid = 3;
    vi.stubEnv("NEXT_PUBLIC_HYMET_TEST_NETWORK", "devnet");
    const result = await body();
    expect(result.holderRewards.mainnetPayoutVerified).toBe(false);
    expect(result.mainnetBroadcasts).toBe(false);
  });

  it("does not claim verification when the check cannot run", async () => {
    h.paid = 3;
    h.failHolderQuery = true;
    expect((await body()).holderRewards.mainnetPayoutVerified).toBe(false);
  });

  it("stays closed unless both switches are on, and read-only mode blocks broadcasts", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    expect(await body()).toMatchObject({ launchesEnabled: false, mainnetBroadcasts: false });
    vi.stubEnv("ENABLE_MAINNET", "true");
    expect(await body()).toMatchObject({ launchesEnabled: true, mainnetBroadcasts: false });
    vi.stubEnv("HYPE_DEV_READ_ONLY", "false");
    expect(await body()).toMatchObject({ launchesEnabled: true, mainnetBroadcasts: true });
  });
});
