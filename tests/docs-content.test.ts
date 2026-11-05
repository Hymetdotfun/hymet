import { describe, expect, it } from "vitest";
import { docsArticles, findDoc } from "../lib/docs-content";
import { HOLDER_PAYOUT_POLICY } from "../lib/holder-payouts.mjs";

const text = (slug: string) => JSON.stringify(findDoc(slug));
const everything = JSON.stringify(docsArticles);

describe("documentation accuracy", () => {
  it("keeps every existing article and the links other pages use", () => {
    expect(docsArticles.map((article) => article.slug)).toEqual(["", "how-hymet-works", "connect-wallet", "create-token", "launch-configuration", "bonding-curve-graduation", "buying-selling", "explore-tokens", "trading-protocol-fees", "fee-distribution", "creator-earnings", "holder-rewards", "hype-meteora", "security-authorities", "faq", "official-links"]);
  });

  it("states the payout policy the keeper enforces", () => {
    expect(HOLDER_PAYOUT_POLICY.minPayout).toBe(10_000_000n);
    expect(HOLDER_PAYOUT_POLICY.minPayoutNewAccount).toBe(50_000_000n);
    expect(HOLDER_PAYOUT_POLICY.intervalMinutes).toBe(15);
    const holders = text("holder-rewards");
    expect(holders).toContain("0.01 HYPE");
    expect(holders).toContain("0.05 HYPE");
    expect(holders).toContain("not a promise of a payment");
  });

  it("separates Mainnet evidence from test environments", () => {
    const security = text("security-authorities");
    expect(security).toContain("Verified on Mainnet");
    expect(security).toContain("Validated only on Devnet, a local validator, or in tests");
    expect(security).toMatch(/Graduation, DBC-to-DAMM v2 migration[^"]*1% fee only/);
    expect(text("holder-rewards")).toContain("No real seller payment has occurred on Mainnet yet");
  });

  it("drops statements written before holder rewards existed", () => {
    for (const stale of ["not active in the current native-split", "Launches are not automatically", "have not passed the Mainnet readiness", "planned holder mechanism", "in the repository", "Migration threshold parameter", "holder features remain gated"]) expect(everything).not.toContain(stale);
  });

  it("publishes only the known public addresses", () => {
    const addresses = (content: string) => [...new Set(content.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) ?? [])].sort();
    expect(addresses(everything)).toEqual(["98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g", "9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px"].sort());
    expect(addresses(`${everything} TestTokenMint1111111111111111111111111111111`)).toContain("TestTokenMint1111111111111111111111111111111");
  });

  it("does not mention tokens excluded from public listings", () => {
    const excluded = (list: string | undefined) => (list ?? "").split(",").map((mint) => mint.trim()).filter(Boolean);
    for (const mint of excluded(process.env.HYMET_PUBLIC_TOKEN_EXCLUDED_MINTS)) expect(everything).not.toContain(mint);
    expect(excluded(" private-test-mint-a, private-test-mint-b ,")).toEqual(["private-test-mint-a", "private-test-mint-b"]);
    expect(everything).not.toContain("private-test-mint-a");
  });
});
