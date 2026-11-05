// Social sharing preview, public/og-image.jpg (scripts/generate-og-image.mjs). Relative URLs resolve against the layout's metadataBase.
const TITLE = "HYMET: The HYPE-Only Launchpad";
const DESCRIPTION = "Create. Launch. Discover. Paired with HYPE. A HYPE-only token launchpad on Solana, powered by Meteora DBC.";
const IMAGE = { url: "/og-image.jpg", width: 1200, height: 630, type: "image/jpeg", alt: "HYMET logo with the headline The HYPE-Only Launchpad" };

export const SHARE_OPEN_GRAPH = { type: "website" as const, siteName: "HYMET", locale: "en_US", title: TITLE, description: DESCRIPTION, images: [IMAGE] };
export const SHARE_TWITTER = { card: "summary_large_image" as const, site: "@Hymetdotfun", title: TITLE, description: DESCRIPTION, images: [IMAGE] };
