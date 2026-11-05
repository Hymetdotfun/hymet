import "./globals.css";
import { SiteFooter, SiteNav } from "../components/site-nav";
import { ScrollReveals } from "../components/scroll-reveals";
import { WalletAppProvider } from "../components/wallet-app-provider";
import { TestNetworkBanner } from "../components/test-network-banner";
import { SHARE_OPEN_GRAPH, SHARE_TWITTER } from "../lib/share-metadata";
export const metadata = { title: "HYMET — Where HYPE Launches", description: "A HYPE-only token launchpad on Solana, powered by Meteora DBC.",
  metadataBase: new URL("https://hymet.fun"),
  openGraph: SHARE_OPEN_GRAPH,
  twitter: SHARE_TWITTER,
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-180x180.png", sizes: "180x180", type: "image/png" },
      { url: "/favicon-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/favicon-512x512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><WalletAppProvider><TestNetworkBanner /><div className="site-frame"><a className="skip-link" href="#main-content">Skip to content</a><SiteNav /><ScrollReveals /><div id="main-content" tabIndex={-1}>{children}</div><SiteFooter /></div></WalletAppProvider></body>
    </html>
  );
}
