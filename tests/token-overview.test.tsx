import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenOverview, tradingFeeRows } from "../components/token-overview";

const MINT = "8QTBDqUVWQjP6KzfrtLkBKhfaFLDenxvqFv2tDkGdMpu";
const CREATOR = "HYKNLVDr4kUQ5hMCEnPKJP3YqLzT2L2Ma6c4NB1gEsun";

it("keeps total trading fees separate from distributable fees and computes the split exactly", () => {
  const rows = tradingFeeRows(250, 10000, 0)!;
  expect(rows.total.map((r) => [r.label, r.value])).toEqual([["Trading fee", "2.5%"], ["Meteora protocol share", "Deducted first"]]);
  expect(rows.distributable.map((r) => [r.label, r.value])).toEqual([["HYMET platform", "20%"], ["Creator", "80%"], ["Holders", "0%"]]);
  expect(tradingFeeRows(100, 5000, 5000)!.distributable.map((r) => r.value)).toEqual(["20%", "40%", "40%"]);
  expect(tradingFeeRows(100, 7000, 7000)).toBeNull();
});

it("renders two panels of label-value rows with the creator, mint and safe social links", () => {
  const html = renderToStaticMarkup(
    <TokenOverview mint={MINT} creator={CREATOR} tradingFeeBps={250} creatorBpsOfRemaining={10000} holderBpsOfRemaining={0}
      socialLinks={{ twitter: "https://x.com/hymetdotfun", website: "javascript:alert(1)" }} launchedAt="2026-11-07T16:43:58Z" />,
  );
  expect(html).toContain(">Trading Fees<");
  expect(html).toContain(">Token Information<");
  expect(html).toContain("Distributable fees · after Meteora&#x27;s share");
  expect(html).toContain(`href="https://solscan.io/account/${CREATOR}"`);
  expect(html).toContain(`href="https://solscan.io/token/${MINT}"`);
  expect(html).toContain('href="https://x.com/hymetdotfun"');
  expect(html).toContain("x.com/hymetdotfun ↗");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("fee-distribution-cards");
});

it("shows an unavailable state instead of guessing an invalid split", () => {
  const html = renderToStaticMarkup(<TokenOverview mint={MINT} creator={CREATOR} tradingFeeBps={250} creatorBpsOfRemaining={7000} holderBpsOfRemaining={7000} socialLinks={{}} />);
  expect(html).toContain("Fee distribution unavailable for this launch record.");
  expect(html).toContain("None provided");
});
