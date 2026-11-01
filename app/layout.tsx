import "./globals.css";
import { SiteFooter, SiteNav } from "../components/site-nav";
import { ScrollReveals } from "../components/scroll-reveals";
import { WalletAppProvider } from "../components/wallet-app-provider";
import { TestNetworkBanner } from "../components/test-network-banner";
export const metadata = { title: "HYMET — Where HYPE Launches", description: "A HYPE-only token launchpad on Solana, powered by Meteora DBC." };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><WalletAppProvider><TestNetworkBanner /><div className="site-frame"><a className="skip-link" href="#main-content">Skip to content</a><SiteNav /><ScrollReveals /><div id="main-content" tabIndex={-1}>{children}</div><SiteFooter /></div></WalletAppProvider></body>
    </html>
  );
}
