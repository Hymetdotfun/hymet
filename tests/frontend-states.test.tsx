import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FeeLedger } from "../components/fee-ledger";
import Dashboard from "../app/dashboard/page";
import Home from "../app/page";
import { MarketPanel } from "../components/market-panel";
import { TokenFeed } from "../components/token-feed";
import { WalletAppProvider } from "../components/wallet-app-provider";

it("shows separate indexed fee categories and keeps inactive holder rewards unavailable", () => {
  const html = renderToStaticMarkup(<WalletAppProvider><FeeLedger /></WalletAppProvider>);
  expect(html).toContain("Fee Overview");
  expect(html).toContain("Total Fees");
  expect(html).toContain("Creator Fees");
  expect(html).toContain("Platform Fees");
  expect(html).toContain("Data unavailable");
  expect(html).toContain("Not active yet");
  expect(html).not.toContain("20% HYPE");
  expect(html).not.toContain("Connect Phantom from the navigation");
  expect(html).not.toContain("Claims unavailable");
});

it("shows loading before asserting an empty market and keeps missing values unitless", () => {
  const html = renderToStaticMarkup(<MarketPanel mint="98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g" />);
  expect(html).toContain("Loading verified market data");
  expect(html).not.toContain("No confirmed OHLCV data indexed");
  expect(html).not.toContain("—%");
  expect(html).not.toContain("$—");
});

it("keeps launch filters accessible while verified records are loading", () => {
  const html = renderToStaticMarkup(<TokenFeed />);
  expect(html).toContain('aria-label="Search launches"');
  expect(html).toContain('aria-label="Launch status"');
  expect(html).toContain("Loading verified launches");
});

it("renders the creator dashboard with shared-wallet guidance and honest market availability", () => {
  const html = renderToStaticMarkup(<WalletAppProvider><Dashboard /></WalletAppProvider>);
  expect(html).toContain("Your Tokens.");
  expect(html).toContain("Your Dashboard.");
  expect(html).toContain("Tokens Created");
  expect(html).toContain("24h Volume (HYPE)");
  expect(html).toContain("Creator allocation indexed");
  expect(html).toContain("Creator claimed");
  expect(html).toContain("Connect your wallet from the navbar");
  expect(html).not.toContain("Connect Wallet");
});

it("uses the approved Explore intro on the homepage without replacing the live token feed", () => {
  const html = renderToStaticMarkup(<Home />);
  expect(html).toContain("Discover What&#x27;s");
  expect(html).toContain("Launching.");
  expect(html).toContain("Explore tokens launched with HYPE. Discover new projects, follow their progress, and find your next opportunity.");
  expect(html).not.toContain("THE DIRECTORY");
  expect(html).not.toContain("Explore launches");
  expect(html).not.toContain("Find a token on the HYPE curve.");
  expect(html).toContain("Loading verified launches");
});
