export type DocsSection = {
  id: string;
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  steps?: string[];
  facts?: [string, string][];
  flow?: string[];
  note?: string;
};

export type DocsArticle = {
  slug: string;
  title: string;
  summary: string;
  category: string;
  sections: DocsSection[];
};

type DocsGroup = { name: string; articles: DocsArticle[] };

const article = (
  slug: string,
  title: string,
  summary: string,
  category: string,
  sections: DocsSection[],
): DocsArticle => ({ slug, title, summary, category, sections });

export const docsGroups: DocsGroup[] = [
  {
    name: "Getting Started",
    articles: [
      article("", "Introduction", "Everything you need to launch, trade, and understand tokens on HYMET.", "Getting Started", []),
      article("how-hymet-works", "How HYMET Works", "A clear path from token setup to trading and fee claims.", "Getting Started", [
        { id: "the-lifecycle", title: "The launch lifecycle", steps: ["Launch — prepare token details and metadata, review the HYPE-paired configuration, then approve the requested transactions in Phantom.", "Trade — buyers and sellers trade the token against HYPE through its verified Meteora pool.", "Graduate — when the configured curve conditions are met, the pool can migrate from Meteora DBC to DAMM v2.", "Earn — eligible fee owners can claim fees accrued to their own verified pool position."] },
        { id: "verified-information", title: "Use verified information", paragraphs: ["HYMET combines confirmed chain state with its launch registry and available market sources. Market data may be delayed or unavailable. The interface labels missing values rather than filling them with estimates.", "A visible listing is not, by itself, proof that a pool is active, a migration is complete, or a transaction is enabled. Check the token page and its linked on-chain records."] },
      ]),
      article("connect-wallet", "Connect Wallet", "Connect Phantom once and use the shared wallet session across HYMET.", "Getting Started", [
        { id: "connect-phantom", title: "Connect Phantom", steps: ["Install Phantom from its official source and unlock your wallet.", "On HYMET, choose Connect Wallet in the site navigation and approve the connection request in Phantom.", "Check the displayed account and network before launching, trading, or claiming fees.", "Review each transaction in Phantom. Approve only the action and amounts you expect."] },
        { id: "wallet-safety", title: "Keep your wallet secure", paragraphs: ["HYMET uses the shared connected wallet for wallet-gated features. A launch, trade, or claim still needs the correct owner account and your signature.", "Never share a recovery phrase or private key with HYMET or a website. Phantom does not need those details to connect to the app."] },
      ]),
    ],
  },
  {
    name: "Launching",
    articles: [
      article("create-token", "Create a Token", "Prepare a name, ticker, artwork, and metadata for your launch.", "Launching", [
        { id: "prepare-token", title: "Prepare your token", steps: ["Connect the creator wallet from the navigation and open Launch a Token.", "Choose a token name and a 1–10 character letter-or-number ticker. HYMET checks names and tickers against its launch reservations and confirmed launch records.", "Add a description and optional website or social links.", "Upload PNG, JPEG, or GIF artwork. HYMET center-crops it to 500 × 500 and processes the image used for metadata to a maximum of 1 MB.", "Review the fee, optional initial buy, and launch summary. Approve the requested transactions in Phantom and wait for confirmation."] },
        { id: "metadata", title: "Metadata and registration", paragraphs: ["HYMET uploads the processed artwork and token metadata through its configured storage service, then checks that the public metadata can be read.", "A launch is registered after HYMET verifies the confirmed transaction and matching token details. Keep the mint address and transaction signature available while confirmation completes."] },
        { id: "launch-costs", title: "Costs to plan for", facts: [["Additional HYMET launch fee", "0 SOL"], ["Quote asset and optional initial buy", "HYPE"], ["Network fees and account rent", "Paid separately in SOL"], ["Meteora charges", "Depend on the applicable protocol and pool configuration"]] },
      ]),
      article("launch-configuration", "Launch Configuration", "The fixed token settings and HYPE-denominated curve parameters.", "Launching", [
        { id: "fixed-settings", title: "Fixed token settings", facts: [["Quote asset", "HYPE only"], ["Token supply", "1,000,000,000"], ["Decimals", "9"], ["Trading fee selection", "0.25%–3%"], ["Additional HYMET launch fee", "0 SOL"]], paragraphs: ["The quote asset and supply settings are fixed by HYMET's launch configuration. The selected trading fee applies to swaps as configured in Meteora; applicable protocol fees and Solana network costs are separate."] },
        { id: "curve-parameters", title: "Curve parameters", facts: [["Starting market-cap parameter", "33.5 HYPE"], ["Migration threshold parameter", "447 HYPE"]], paragraphs: ["These are fixed HYPE-denominated configuration values, not USD pegs. Any displayed USD equivalent changes with the HYPE market price. The curve does not promise that a token will reach its migration threshold."] },
        { id: "initial-buy", title: "Optional initial buy", paragraphs: ["A creator may include an initial HYPE buy in the reviewed launch flow. It is a separate purchase, not a platform launch fee. Make sure the connected wallet has the required HYPE and enough SOL for network fees and any account rent."] },
      ]),
      article("bonding-curve-graduation", "Bonding Curve & Graduation", "How HYPE trading begins on Meteora DBC and can move to DAMM v2.", "Launching", [
        { id: "before-graduation", title: "Before graduation", paragraphs: ["A Meteora Dynamic Bonding Curve (DBC) pool provides the initial market for a HYMET token. The token is paired with HYPE, and trades follow the pool's configured curve and trading-fee settings.", "HYMET uses a fixed curve configuration. The starting parameter is 33.5 HYPE and the migration threshold is 447 HYPE. These values are denominated in HYPE; they do not guarantee a particular dollar valuation or trading outcome."] },
        { id: "graduation-and-migration", title: "Graduation and migration", paragraphs: ["Graduation eligibility follows the configured pool conditions. A threshold reading or progress indicator is not proof that migration finished. HYMET verifies the observed DBC state and checks the DAMM v2 destination account and token pair before reporting a migration as verified.", "HYMET's status reader observes and reports chain state; it does not make an unverified migration complete. After migration, the DBC trading path is no longer the applicable pool path. Use a supported, verified DAMM v2 route when available."] },
        { id: "liquidity-after-migration", title: "Liquidity and fees after migration", facts: [["HYMET position allocation", "20% of configured migration liquidity"], ["Creator position allocation", "80% of configured migration liquidity"], ["Position lock configuration", "Permanent lock for both positions"]], paragraphs: ["This migration-liquidity allocation is separate from the 20/80 distribution of eligible trading fees. Each position owner claims fees accrued to its own position. The configured custom migration fee is zero; any separate Meteora protocol charge, if applicable, is not a HYMET launch fee."], note: "Use the launch review and confirmed on-chain state as the source of truth for a particular pool." },
      ]),
    ],
  },
  {
    name: "Trading",
    articles: [
      article("buying-selling", "Buying & Selling", "Trade a verified HYMET token using HYPE and the shared wallet.", "Trading", [
        { id: "trade-steps", title: "Make a trade", steps: ["Open the token detail page and confirm its mint and pool status.", "Connect the wallet from the navigation if it is not already connected.", "Choose Buy or Sell, enter an amount, and review the quote and slippage tolerance.", "Open the transaction in Phantom and inspect the route and amounts.", "Approve only if the transaction details are correct, then wait for chain confirmation."] },
        { id: "trade-routes", title: "Pool routes and price movement", paragraphs: ["Before migration, HYMET builds HYPE trades against the verified Meteora DBC pool. When a pool has migrated, the DBC route is closed. A DAMM v2 trade can proceed only when a supported route is available and the pool is verified.", "Quotes can change before confirmation. Slippage tolerance limits acceptable execution movement; it does not guarantee a fill at the quoted price. Keep enough SOL for network fees even though HYPE is the quote asset."] },
      ]),
      article("explore-tokens", "Explore Tokens", "Find launch records and review the market information that is available.", "Trading", [
        { id: "directory", title: "Use Explore", paragraphs: ["Search by token name, ticker, or mint. Use the available status filters and sorting to narrow the directory, then open a card to inspect the token page.", "Public listings use HYMET launch records and available market-data sources. A token's market cap, volume, price, or chart can be unavailable if a verified source has not returned that value."] },
        { id: "listing-visibility", title: "Listing visibility", paragraphs: ["Some test mints are excluded from public directory results. A listing exclusion affects public discovery only; it does not erase the token's on-chain state, transaction history, creator history, or fee accounting."] },
      ]),
    ],
  },
  {
    name: "Fees & Rewards",
    articles: [
      article("trading-protocol-fees", "Trading & Protocol Fees", "Understand the selected pool fee, Meteora protocol charges, and costs outside the pool.", "Fees & Rewards", [
        { id: "selected-fee", title: "Trading fee selected for a launch", facts: [["Supported selected rate", "0.25%–3%"], ["Fee mode", "Fixed; dynamic fees disabled"], ["After migration", "Configured DAMM v2 fee matches the selected rate"]], paragraphs: ["The selected rate is a pool trading fee applied to swap activity according to Meteora's pool configuration. It is not a percentage charged by HYMET on the full value of a buy or sell."] },
        { id: "protocol-deduction", title: "Meteora protocol fees and eligible revenue", paragraphs: ["Meteora's applicable protocol fees are determined by the protocol and pool configuration. Where protocol fees are deducted from the LP trading fee, HYMET's 20/80 split applies to the remaining eligible distributable trading fees—not to the entire transaction value and not to amounts already deducted as protocol fees.", "Solana transaction fees, account rent, and any optional initial buy are separate costs. HYMET configures no additional SOL launch fee. The custom migration-fee configuration is zero; any independent Meteora migration or protocol charge, if applicable, is separate."] },
        { id: "platform-use", title: "HYMET Buyback & Burn", paragraphs: ["HYMET designates 100% of its 20% platform allocation from eligible distributable trading fees for the Buyback & Burn of $HYMET. The intended use is to collect eligible platform revenue, purchase $HYMET, and burn the purchased tokens. This platform allocation does not reduce the creator's configured 80% share.", "This is an allocation policy, not a claim that a buyback or burn is currently automated or active. The repository does not contain an operational buyback-and-burn mechanism or verified burn history. No schedule, supply reduction, or completed purchase is implied."], flow: ["Trading Activity", "Eligible Distributable Fees", "20% HYMET Allocation", "$HYMET Buyback", "Token Burn"], note: "Meteora protocol fees are protocol charges. They are separate from HYMET platform revenue and are not part of the buyback allocation." },
      ]),
      article("fee-distribution", "Fee Distribution", "How eligible distributable trading fees are allocated between HYMET and the creator.", "Fees & Rewards", [
        { id: "native-split", title: "The current native split", facts: [["HYMET platform allocation", "20% of eligible distributable trading fees"], ["Creator-controlled allocation", "Remaining 80%"], ["Automatic holder distribution", "Not active in the current native-split mode"]], paragraphs: ["In the current native-split configuration, Meteora routes 20% of eligible DBC LP trading fees after applicable protocol deductions to HYMET's configured platform fee recipient. The remaining 80% is routed to the creator. The HYMET share is never routed to the creator.", "The launch interface's holder allocation stays disabled unless the existing distributor and operational keeper readiness checks pass. In the active native-split mode, the creator receives the 80% share; HYMET does not automatically distribute it to holders."] },
        { id: "after-migration", title: "After DBC-to-DAMM v2 migration", paragraphs: ["The configured migration allocates 20% of migration liquidity to the HYMET-owned position and 80% to the creator-owned position, with both positions permanently locked. This is a liquidity allocation, not the trading-fee percentage. Fee collection follows the owner of each DBC fee destination or DAMM v2 position.", "Pool trading fees, protocol deductions, position claims, migration-related protocol costs, and the additional HYMET launch fee are different accounting categories. The additional HYMET launch fee is 0 SOL."] },
        { id: "buyback-policy", title: "HYMET Buyback & Burn", paragraphs: ["HYMET designates all of its platform allocation for the intended $HYMET Buyback & Burn. The creator's 80% share is unchanged. This policy does not mean purchases or burns are automated, scheduled, or already executed; no operational mechanism or verified burn history is present in the repository."], flow: ["Trading Activity", "Eligible Distributable Fees", "20% HYMET Allocation", "$HYMET Buyback", "Token Burn"] },
      ]),
      article("creator-earnings", "Creator Earnings", "Check and claim fees accrued to the creator's verified pool position.", "Fees & Rewards", [
        { id: "claimable-fees", title: "Claiming creator fees", paragraphs: ["Creator fees become claimable when eligible fees accrue to the creator's DBC fee destination or migrated DAMM v2 position. The connected wallet must match the owner verified by the claim flow.", "Use Fees & Rewards or the token page to inspect the token, pool, and claimable amount. Phantom signs the claim transaction. A claim is complete only after the transaction confirms."] },
        { id: "accounting-states", title: "Read fee amounts correctly", facts: [["Indexed", "Recorded from verified chain events; may lag chain state"], ["Claimable", "Available to claim from the verified fee destination or position"], ["Claimed", "Recorded as paid after confirmation, where indexed"]], paragraphs: ["These amounts describe different accounting states and should not be added together as though they were one total. The creator's fee view excludes HYMET platform fees."] },
      ]),
      article("holder-rewards", "Holder Rewards", "Current status and the requirements for any future HYPE distribution.", "Fees & Rewards", [
        { id: "holder-status", title: "Current availability", paragraphs: ["Automatic holder payouts are not active in the current native-split launch mode. The distributor and payout keeper have not passed the Mainnet readiness checks required to enable holder allocation and claims. There is no active holder claim control in this mode.", "The planned holder mechanism is passive and HYPE-denominated: no staking, deposit, or token lock is intended. A proposed allocation or a saved snapshot alone does not create a funded, payable entitlement."] },
        { id: "future-eligibility", title: "What a funded distribution requires", bullets: ["A verified distributor deployment and operational payout keeper.", "A deterministic snapshot of eligible token ownership at the defined chain state.", "An on-chain funded epoch whose committed Merkle root matches wallet-specific entitlements.", "A valid wallet proof and a successful, replay-protected claim transaction."] },
        { id: "no-platform-holder-mix", title: "Separate from platform revenue", paragraphs: ["HYMET's 20% platform allocation is designated for the intended $HYMET Buyback & Burn. It is not holder reward funding and does not reduce the creator-controlled 80% fee share."] },
      ]),
    ],
  },
  {
    name: "Protocol",
    articles: [
      article("hype-meteora", "HYPE & Meteora", "The configured quote asset and the pool protocols used by HYMET.", "Protocol", [
        { id: "hype-asset", title: "HYPE quote asset", facts: [["Quote", "HYPE only"], ["Mint", "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g"], ["Token program", "Standard SPL Token"], ["Decimals", "9"]], paragraphs: ["HYMET validates the configured HYPE mint and token account before constructing launch transactions. HYPE is the quote asset; SOL may still be needed for transaction fees and account rent."] },
        { id: "meteora-protocols", title: "Meteora DBC and DAMM v2", paragraphs: ["HYMET uses Meteora's Dynamic Bonding Curve for the initial HYPE-paired market and configures DAMM v2 as the migration destination. Fee selection, pool settings, and recipients are validated when a transaction is prepared and again during launch confirmation.", "For migration status, HYMET checks the DBC state and verifies the DAMM v2 destination owner, account layout, and token pair. Unsupported or mismatched account state is not treated as a verified migration."] },
      ]),
      article("security-authorities", "Security & Authorities", "Know which wallet signs, which roles control fees, and what is verified.", "Protocol", [
        { id: "wallet-signing", title: "Wallet signing", paragraphs: ["The connected wallet signs its own launch, trade, and claim transactions in Phantom. HYMET does not ask for a private key or recovery phrase. Read the network, recipient, and amounts in the wallet prompt before approving."] },
        { id: "roles", title: "Authority roles", facts: [["Mint and freeze authorities", "Verified as revoked before launch registration"], ["Creator fee authority", "The creator-owned DBC fee destination or DAMM v2 position"], ["Platform fee recipient", "The separately configured HYMET recipient; platform claims are owner-authorized"], ["Distributor snapshot authority", "A keeper role for a verified rewards distributor; holder features remain gated"], ["Program upgrade authority", "Controls whether an on-chain program can be upgraded; distinct from fee and snapshot roles"]], paragraphs: ["HYMET verifies the confirmed mint has no mint or freeze authority before registering the launch. Wallet addresses, program IDs, and authority roles are different things. This documentation does not publish operational wallet identities. The application checks the relevant owner, account, signature, and transaction state for each operation."] },
        { id: "availability-checks", title: "Transaction availability", paragraphs: ["Mainnet transaction construction is guarded by both server and public configuration. A page being available does not mean every transaction or rewards feature is enabled. HYMET also validates the configured HYPE mint, network, pool accounts, fee recipients, and confirmed launch state where applicable."], note: "These checks are not a security audit or guarantee. Review each wallet request and verify addresses and signatures independently." },
      ]),
    ],
  },
  {
    name: "Resources",
    articles: [
      article("faq", "FAQ", "Quick answers about HYPE, fees, migration, and holder rewards.", "Resources", [
        { id: "questions", title: "Frequently asked questions", bullets: ["Can I launch with SOL? No. HYMET uses HYPE as its only quote asset. SOL may still be needed for network fees and rent.", "Does HYMET charge a launch fee? The additional HYMET launch fee is 0 SOL. Meteora charges, Solana costs, rent, and an optional initial buy are separate.", "Is the selected trading fee charged on the whole trade value by HYMET? No. It is the pool's configured trading fee. Applicable protocol deductions are separate; the 20/80 split applies to eligible distributable fees.", "Are HYMET buybacks and burns already operating? No automated mechanism or verified burn history is present in the repository. The platform allocation is designated for that intended use.", "Are holder rewards active? No. Distributor and payout-keeper readiness checks have not enabled them in the native-split mode.", "Does reaching the curve threshold mean migration is finished? No. HYMET reports verified migration only after checking on-chain destination state."] },
      ]),
      article("official-links", "Official Links", "Open HYMET features and the configured ecosystem resources.", "Resources", [
        { id: "hymet-pages", title: "HYMET pages", paragraphs: ["Use these links to open the current application features. External links open in a separate tab so you can confirm the destination domain before connecting a wallet."], bullets: ["Launch Studio — create and review a HYPE-paired token.", "Explore — search confirmed public launch records.", "Fees & Rewards — review verified fee activity and eligible claim flows."] },
        { id: "ecosystem", title: "Ecosystem resources", bullets: ["Meteora — protocol information and ecosystem resources.", "Phantom — official wallet download.", "HYPE source registry — token-pairing reference used by HYMET."] },
      ]),
    ],
  },
];

export const docsArticles = docsGroups.flatMap((group) => group.articles);
export const findDoc = (slug: string) => docsArticles.find((item) => item.slug === slug);
export const docHref = (slug: string) => slug ? `/docs/${slug}` : "/docs";
