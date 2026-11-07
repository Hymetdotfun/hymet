import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BurnTracker } from "../components/burn-tracker";
import { WalletAppProvider } from "../components/wallet-app-provider";
import Dashboard from "../app/dashboard/page";

it("shows the burn tracker loading without any unverified figures", () => {
  const html = renderToStaticMarkup(<BurnTracker />);
  expect(html).toContain("$HYMET Burn Tracker");
  expect(html).toContain("Team buyback burns");
  expect(html).toContain("Other on-chain burns");
  expect(html).toContain("Loading…");
  expect(html).not.toMatch(/\d+(\.\d+)?%/);
  expect(html).toContain("Transfers to dead wallets do not reduce supply and are not counted.");
});

it("places the burn tracker on the dashboard after the overview", () => {
  const html = renderToStaticMarkup(<WalletAppProvider><Dashboard /></WalletAppProvider>);
  const overview = html.indexOf('id="dashboard-overview-title"');
  const tracker = html.indexOf('id="burn-tracker-title"');
  const tokens = html.indexOf(">My Tokens<");
  expect(overview).toBeGreaterThan(-1);
  expect(tracker).toBeGreaterThan(overview);
  expect(tokens).toBeGreaterThan(tracker);
});
