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

/** Build-time flag: the wording follows the deployment's launch gate. */
const launchesOpen = process.env.NEXT_PUBLIC_ENABLE_MAINNET === "true";

const FEE_FLOW = ["Trading Fee", "Meteora Share", "Distributable Fees", "20% HYMET", "80% Creator & Holders"];
const BUYBACK_FLOW = ["Trading Activity", "Distributable Fees", "20% HYMET Allocation", "Manual $HYMET Buyback", "Manual Burn"];
const BUYBACK_POLICY = "HYMET designates 100% of its 20% platform allocation for the Buyback & Burn of $HYMET. The intended use is to collect platform revenue, purchase $HYMET, and burn the purchased tokens. This is an allocation policy carried out manually by HYMET: no part of the app, keeper or distributor program buys or burns $HYMET automatically, and this documentation does not claim that any purchase, burn, schedule, or supply reduction has taken place.";

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
      article("how-hymet-works", "How HYMET Works", "A clear path from token setup to trading, fee settlement, claims, and holder payouts.", "Getting Started", [
        { id: "the-lifecycle", title: "The launch lifecycle", steps: [
          "Launch — prepare token details and metadata, choose the trading fee and the creator/holder split, then approve the launch in Phantom.",
          "Trade — buyers and sellers trade the token against HYPE through its Meteora Dynamic Bonding Curve (DBC) pool. Every trade pays the pool's trading fee in HYPE.",
          "Settle — HYMET's keeper regularly moves collected fees into the distributor, which applies the split fixed at launch.",
          "Earn — creators claim their share, and holders with a holder share receive HYPE automatically when a payout round runs and they qualify.",
          "Graduate — when the curve holds its migration threshold, the pool migrates to Meteora DAMM v2. Liquidity is permanently locked and fees continue under the same split.",
        ] },
        { id: "the-keeper", title: "What the keeper does", paragraphs: [
          "The keeper is HYMET's automated server process. It runs about every 5 minutes and handles what no user transaction covers: settling fees, running holder payout rounds, migrating completed curves, and registering the resulting DAMM v2 pool.",
          "The keeper's permissions are narrow. It can fund payout rounds from the holder pool and close them, but it cannot reach creator or HYMET funds, change a token's split, or remove locked liquidity.",
        ] },
        { id: "verified-information", title: "Use verified information", paragraphs: [
          "HYMET combines confirmed chain state with its launch registry and available market sources. Market data may be delayed or unavailable. The interface labels missing values rather than filling them with estimates.",
          "A visible listing is not, by itself, proof that a pool is active, a migration is complete, or a transaction is enabled. Check the token page and its linked on-chain records. Identify a token by its mint address, because names and tickers do not have to be unique.",
        ] },
      ]),
      article("connect-wallet", "Connect Wallet", "Connect Phantom once and use the shared wallet session across HYMET.", "Getting Started", [
        { id: "connect-phantom", title: "Connect Phantom", steps: ["Install Phantom from its official source and unlock your wallet.", "On HYMET, choose Connect Wallet in the site navigation and approve the connection request in Phantom.", "Check the displayed account and network before launching, trading, or claiming fees.", "Review each transaction in Phantom. Approve only the action and amounts you expect."] },
        { id: "wallet-safety", title: "Keep your wallet secure", paragraphs: ["HYMET uses the shared connected wallet for wallet-gated features. A launch, trade, or claim still needs the correct owner account and your signature. Holder payouts need no signature or wallet connection.", "Never share a recovery phrase or private key with HYMET or a website. Phantom does not need those details to connect to the app."] },
        { id: "wallet-support", title: "Supported wallet", paragraphs: ["Phantom is the only wallet HYMET has tested. Phantom may add its own safety instructions to a transaction; HYMET checks them before you sign. Such a guard can occasionally stop a swap when the price moves, in which case nothing is traded and you can request a new quote."] },
      ]),
    ],
  },
  {
    name: "Launching",
    articles: [
      article("create-token", "Create a Token", "Prepare a name, ticker, artwork, fee, and creator/holder split for your launch.", "Launching", [
        { id: "prepare-token", title: "Prepare your token", steps: [
          "Connect the creator wallet from the navigation and open Launch a Token.",
          "Choose a token name and a 1–10 character letter-or-number ticker. Names and tickers do not have to be unique, so always identify a token by its mint address.",
          "Add a description and optional website or social links.",
          "Upload PNG, JPEG, or GIF artwork. HYMET center-crops it to 500 × 500 and processes the image used for metadata to a maximum of 1 MB.",
          "Select the trading fee and divide the creator-controlled 80% between the creator and holders, from 0% to 100%. The split cannot be changed after launch.",
          "Review the optional initial buy and launch summary. Approve the launch in Phantom and wait for confirmation.",
        ] },
        { id: "metadata", title: "Metadata and registration", paragraphs: ["HYMET uploads the processed artwork and token metadata through its configured storage service, then checks that the public metadata can be read.", "A launch is registered after HYMET verifies the confirmed transaction and matching token details. Keep the mint address and transaction signature available while confirmation completes."] },
        { id: "launch-costs", title: "Costs to plan for", facts: [["Additional HYMET launch fee", "0 SOL"], ["Account rent for the curve, pool, mint, and metadata", "About 0.0187 SOL"], ["Holder-share launch: fee pool and its vaults", "About 0.0046 SOL more"], ["Creator token account, only with an initial buy", "About 0.0015 SOL"], ["Network fees", "About 0.00002 SOL, plus any wallet priority fee"], ["Optional initial buy", "Paid in HYPE, including the normal trading fee"]], note: "Rent and network estimates can change with Solana conditions. Phantom shows the actual amounts before you approve." },
      ]),
      article("launch-configuration", "Launch Configuration", "The fixed token settings, the choices a creator makes, and the HYPE-denominated curve.", "Launching", [
        { id: "fixed-settings", title: "Fixed token settings", facts: [["Quote asset", "HYPE only"], ["Token supply", "1,000,000,000"], ["Decimals", "9"], ["Additional HYMET launch fee", "0 SOL"], ["Mint and freeze authorities", "Verified as revoked before registration"]], paragraphs: ["These settings are fixed by HYMET's launch configuration and are the same for every launch."] },
        { id: "creator-choices", title: "What the creator chooses", facts: [["Trading fee", "0.25%–3%, flat, collected in HYPE"], ["Creator share of the 80%", "0%–100%, in whole percentages"], ["Holder share of the 80%", "The remainder, 0%–100%"], ["Initial buy", "Optional"]], paragraphs: ["The trading fee and the split are fixed at launch. A launch that keeps 100% with the creator uses Meteora's native split. Any launch with a holder share uses the HYMET distributor, which enforces its split on-chain. See Fee Distribution."] },
        { id: "curve-parameters", title: "Curve parameters", facts: [["Starting market cap", "33.5 HYPE"], ["Graduation market cap", "447 HYPE"], ["HYPE in the curve at graduation", "About 96.07 HYPE"], ["Total buyer spend to graduate at a 1% fee", "About 97.04 HYPE"], ["Tokens sold on the curve", "About 785.1 million (78.5%)"]], paragraphs: ["Market cap prices the whole supply at the current price, so it is much larger than the HYPE actually deposited. Graduation depends on the HYPE held by the curve. These values are fixed in HYPE, not pegged to USD, and any displayed USD equivalent moves with the HYPE price. The curve does not promise that a token will graduate."] },
        { id: "initial-buy", title: "Optional initial buy", paragraphs: ["A creator may include an initial HYPE buy in the launch. It is a separate purchase that pays the normal trading fee, not a platform launch fee. Make sure the connected wallet has the required HYPE and enough SOL for network fees and account rent."] },
      ]),
      article("bonding-curve-graduation", "Bonding Curve & Graduation", "How HYPE trading begins on Meteora DBC and moves to DAMM v2, and what happens to fees.", "Launching", [
        { id: "before-graduation", title: "Before graduation", paragraphs: ["A Meteora Dynamic Bonding Curve pool provides the initial market for a HYMET token. The token is paired with HYPE, and trades follow the pool's fixed curve and selected trading fee.", "Graduation depends on the HYPE held by the curve, about 96.07 HYPE, which corresponds to a 447 HYPE market cap. These values do not guarantee a particular dollar valuation or trading outcome."] },
        { id: "graduation-and-migration", title: "Graduation and migration", paragraphs: ["When a buy completes the curve, the keeper migrates the pool to DAMM v2 and registers the canonical pool that Meteora's migration creates. Any later keeper run finishes the work if the first attempt is interrupted.", "A progress reading is not proof that migration finished. HYMET checks the DBC state and verifies the DAMM v2 destination account and token pair before reporting a migration as verified. After migration, the DBC route is closed and trading continues through DAMM v2."] },
        { id: "liquidity-after-migration", title: "Liquidity and fees after migration", facts: [["Launch with a holder share", "100% of migration liquidity in a position owned by the distributor's fee pool"], ["100% creator launch", "20% in a HYMET position, 80% in a creator position"], ["Position lock", "Permanent for all positions"], ["Trading fee after migration", "The same flat rate selected at launch"], ["Custom migration fee", "0"]], paragraphs: ["With a holder share, DAMM v2 position fees are settled into the same distributor and split exactly as before: 20% to HYMET, then the creator and holder shares fixed at launch. DBC fees still uncollected at migration are settled the same way. The distributor has no instruction that removes liquidity or moves the position.", "In a 100% creator launch, the 20/80 figures are liquidity allocations, and each position owner claims the fees of its own position."], note: "Graduation and DAMM v2 trading and fee settlement have been validated on Devnet and a local validator at a 1% trading fee, not yet on Mainnet. See Security & Authorities." },
      ]),
    ],
  },
  {
    name: "Trading",
    articles: [
      article("buying-selling", "Buying & Selling", "Trade a verified HYMET token using HYPE and the shared wallet.", "Trading", [
        { id: "trade-steps", title: "Make a trade", steps: ["Open the token detail page and confirm its mint and pool status.", "Connect the wallet from the navigation if it is not already connected.", "Choose Buy or Sell, enter an amount, and review the quote and slippage tolerance.", "Open the transaction in Phantom and inspect the route and amounts.", "Approve only if the transaction details are correct, then wait for chain confirmation."] },
        { id: "trade-routes", title: "Pool routes and price movement", paragraphs: ["Before migration, HYMET builds HYPE trades against the verified Meteora DBC pool. When a pool has migrated, the DBC route is closed. A DAMM v2 trade can proceed only when a supported route is available and the pool is verified.", "Quotes can change before confirmation. Slippage tolerance limits acceptable execution movement; it does not guarantee a fill at the quoted price. Keep enough SOL for network fees even though HYPE is the quote asset."] },
        { id: "trading-and-rewards", title: "How trading affects holder rewards", paragraphs: ["On a token with a holder share, your balance at each funded payout snapshot determines your share of that round. There is no minimum holding period. Selling before a snapshot means you earn no share of the fees allocated at that snapshot, but any amount already carried for your wallet stays yours. See Holder Rewards."] },
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
      article("trading-protocol-fees", "Trading & Protocol Fees", "How the trading fee is divided between Meteora, HYMET, the creator, and holders.", "Fees & Rewards", [
        { id: "selected-fee", title: "Trading fee selected for a launch", facts: [["Supported rate", "0.25%–3%"], ["Fee mode", "Flat; dynamic fees disabled"], ["Collected in", "HYPE"], ["After migration", "DAMM v2 uses the same rate"]], paragraphs: ["The selected rate is charged on each swap according to Meteora's pool configuration. HYMET does not charge a further percentage on the value of a buy or sell."] },
        { id: "protocol-deduction", title: "Meteora's share and distributable fees", facts: [["Meteora, on DBC pools", "20% of the trading fee"], ["Distributable fees, on DBC pools", "The remaining 80% of the trading fee"], ["HYMET", "20% of distributable fees"], ["Creator and holders", "80% of distributable fees"]], paragraphs: ["Meteora takes its protocol share first, and HYMET's split applies only to what remains. Meteora's protocol sets its own share on DAMM v2 pools; the trade panel shows the fee and protocol amounts before you trade.", "Solana transaction fees, account rent, and any optional initial buy are separate costs. HYMET configures no additional launch fee, and the custom migration fee is zero."], flow: FEE_FLOW },
        { id: "worked-example", title: "Worked example", facts: [["Trade", "100 HYPE at a 1% fee"], ["Trading fee", "1.00 HYPE"], ["Meteora", "0.20 HYPE"], ["HYMET", "0.16 HYPE"], ["Creator, in a 50/50 split", "0.32 HYPE"], ["Holders, in a 50/50 split", "0.32 HYPE"]], note: "This example describes a DBC pool and is rounded for clarity. The on-chain calculation uses exact base units." },
        { id: "platform-use", title: "HYMET Buyback & Burn", paragraphs: [BUYBACK_POLICY, "HYMET's allocation is always its 20% of distributable fees and does not reduce the creator and holder share."], flow: BUYBACK_FLOW, note: "Meteora protocol fees are protocol charges. They are separate from HYMET platform revenue and are not part of the buyback allocation." },
      ]),
      article("fee-distribution", "Fee Distribution", "The complete split between HYMET, the creator, and holders, from 0% to 100%.", "Fees & Rewards", [
        { id: "the-split", title: "How the split works", paragraphs: ["HYMET receives a fixed 20% of distributable trading fees. When launching, the creator divides the remaining 80% between themselves and the token's holders, from 0% to 100%. The split is fixed at launch and cannot be changed afterward."], facts: [["100% creator, 0% holders", "HYMET 20%, creator 80%, holders 0%"], ["75% creator, 25% holders", "HYMET 20%, creator 60%, holders 20%"], ["50% creator, 50% holders", "HYMET 20%, creator 40%, holders 40%"], ["25% creator, 75% holders", "HYMET 20%, creator 20%, holders 60%"], ["0% creator, 100% holders", "HYMET 20%, creator 0%, holders 80%"]], note: "All percentages in this table are shares of distributable fees, after Meteora's protocol share." },
        { id: "two-routes", title: "Two on-chain routes", bullets: ["Launch with a holder share: the HYMET distributor program receives the fees and enforces the split. Funds can leave it only as the HYMET share, a creator claim, or holder payouts.", "100% creator launch: Meteora's native split routes 20% to HYMET's fee recipient and 80% to the creator. No distributor or holder payout is involved."] },
        { id: "keeper-settlement", title: "Keeper settlement", paragraphs: ["With a holder share, fees earned by the pool stay with Meteora until they are settled into the distributor. Settlement measures the HYPE received and splits it in one transaction: HYMET's 20% is sent at once, the creator's share becomes claimable, and the holder share joins the holder pool.", "The keeper checks for collectible fees about every 5 minutes and skips settlement when there is nothing to collect. Anyone may trigger settlement, and it cannot change the result. Until settlement runs, recently earned fees are not yet claimable or payable."], flow: ["Meteora Pool Fees", "Keeper Settlement", "HYMET Sent", "Creator Claimable", "Holder Pool"] },
        { id: "after-migration", title: "After DBC-to-DAMM v2 migration", paragraphs: ["With a holder share, the distributor owns the permanently locked DAMM v2 position, so fees from that position are settled and split under the same rules. Any DBC fees not yet collected are settled too. In a 100% creator launch, 20% of the migration liquidity sits in a HYMET position and 80% in a creator position, both permanently locked, and each owner claims its own position's fees.", "Trading fees, Meteora's share, position claims, and migration costs are different accounting categories. The additional HYMET launch fee is 0 SOL, and the custom migration fee is zero."] },
        { id: "buyback-policy", title: "HYMET Buyback & Burn", paragraphs: [BUYBACK_POLICY], flow: BUYBACK_FLOW },
      ]),
      article("creator-earnings", "Creator Earnings", "How creators claim their share in each launch route.", "Fees & Rewards", [
        { id: "claimable-fees", title: "Claiming with a holder share", steps: ["Open Fees & Rewards with the creator wallet connected.", "Under Your Launch Pools, choose Claim creator fees for the token.", "Review the amount in Phantom and approve. The HYPE goes to the creator's HYPE account once the transaction confirms."], paragraphs: ["The claimable amount grows when the keeper settles fees. The minimum payout thresholds apply to holder payouts, not to creator claims. Only the creator wallet recorded at launch can claim, and a claim needs a little SOL for network fees."] },
        { id: "native-claims", title: "Claiming in a 100% creator launch", paragraphs: ["Creator fees accrue to the creator's DBC fee destination and, after migration, to the creator's DAMM v2 position. The connected wallet must match the owner verified by the claim flow, and the claim is complete only after the transaction confirms."] },
        { id: "accounting-states", title: "Read fee amounts correctly", facts: [["Indexed", "Recorded from verified chain events; may lag chain state"], ["Claimable", "Settled or accrued and available to claim"], ["Claimed", "Recorded as paid after confirmation"]], paragraphs: ["These amounts describe different accounting states and should not be added together as though they were one total. The creator's fee view excludes HYMET platform fees."] },
      ]),
      article("holder-rewards", "Holder Rewards", "How holders earn HYPE, when payouts run, and what happens to amounts too small to pay.", "Fees & Rewards", [
        { id: "holder-status", title: "Current availability", paragraphs: [
          `Holder rewards are live on the Mainnet distributor, and confirmed Mainnet payouts have been recorded and reconciled.${launchesOpen ? "" : " Public launches are not open yet."} They apply only to tokens launched with a holder share, and the Fees & Rewards page shows payout activity.`,
          "Holders do not stake, lock, or claim anything. Eligible payouts arrive directly in the wallet's HYPE account, and the keeper pays the network fees.",
        ] },
        { id: "no-guarantee", title: "Payouts are not guaranteed every 15 minutes", paragraphs: ["Fifteen minutes is the shortest time between payout rounds for a token, not a promise of a payment. A round runs only when settled holder fees are available and at least one wallet has reached its payout minimum. Your wallet is paid in that round only if your own amount reaches your minimum.", "If trading is quiet, fees are small, or no one qualifies, no round runs and no HYPE is paid. Rewards depend entirely on real trading fees and are not a return, yield, or guarantee."] },
        { id: "eligibility", title: "Holder eligibility and snapshots", paragraphs: ["At the start of a round, the keeper reads every token account for the mint at a single Solana slot. Your share is your balance divided by the total eligible balance at that moment. Only the snapshot balance counts: there is no minimum holding period or time weighting."], bullets: ["Eligible: a normal wallet holding a balance of the token.", "Not eligible: empty or frozen token accounts.", "Not eligible: accounts owned by program addresses, such as pool vaults and most staking or lending protocols, even if they hold tokens on your behalf.", "Not eligible: the incinerator, the HYMET platform wallet, and the token's fee pool."] },
        { id: "payout-rounds", title: "Automatic payout rounds", steps: [
          "The keeper settles collected fees, adding the holder share to the holder pool.",
          "It checks that the holder pool has reached the minimum and that 15 minutes have passed since the token's last snapshot. A token's first payout has no waiting period.",
          "It takes the snapshot and calculates each wallet's share plus any amount already carried.",
          "It commits the round on-chain, then pays qualifying wallets in HYPE, in groups of up to 6 wallets per transaction.",
          "It closes the round and records the results.",
        ], paragraphs: ["The keeper runs about every 5 minutes, so a due round starts at the next run rather than at an exact time. A round is delayed if the keeper or the network is unavailable, or if the keeper needs more SOL; the funds stay in the holder pool and later runs continue. If a funded round is not fully paid before it expires after about 7 days, the unpaid amount returns to the holder pool."] },
        { id: "payout-minimums", title: "Minimum payout thresholds", facts: [["Wallet already has a HYPE account", "0.01 HYPE"], ["Keeper must create a HYPE account", "0.05 HYPE"]], paragraphs: ["The higher minimum applies because creating a HYPE account costs the keeper about 0.0015 SOL of rent. The minimums prevent payments that would cost more to send than they are worth."] },
        { id: "carry-over", title: "Unpaid carry-over", paragraphs: ["When a funded round allocates you less than your minimum, that amount is carried over and recorded under your wallet. It stays in the on-chain holder pool, is added to your next allocation, and is paid when the total reaches your minimum. The Fees & Rewards page shows carried amounts for the connected wallet.", "A carried amount is never given to another wallet and does not expire. It can also remain unpaid indefinitely if it never reaches your minimum."], note: "If no wallet qualifies at a snapshot, no round is funded and nothing is allocated. The HYPE stays in the holder pool for a later snapshot, where it is shared among the holders at that time." },
        { id: "sellers", title: "If you sell", bullets: ["Selling before a funded snapshot means you receive no share of the fees allocated at that snapshot. Those fees go to the holders at the snapshot.", "Selling part of your position reduces your share in proportion to your remaining balance.", "Selling does not forfeit an amount already carried for your wallet. It remains yours and is never redistributed.", "A wallet that has fully sold can still be paid its carried amount once that amount reaches its minimum, even without holding again.", "Before paying such a wallet, the keeper proves its balance from the original snapshot against the record committed on-chain. If the proof fails or is unavailable, nothing is paid and the amount stays carried until it can be proven.", "Because carried amounts are usually small, most amounts left by sold wallets stay carried unless they reach the minimum, for example after the wallet holds the token again."], note: "The seller payment path has been simulated and covered by automated tests. No real seller payment has occurred on Mainnet yet." },
        { id: "no-platform-holder-mix", title: "Separate from platform revenue", paragraphs: ["Holder rewards come only from each token's own holder share. HYMET's 20% allocation is designated for the intended $HYMET Buyback & Burn. It is not holder reward funding and does not reduce the creator and holder share."] },
      ]),
    ],
  },
  {
    name: "Protocol",
    articles: [
      article("hype-meteora", "HYPE & Meteora", "The quote asset and the pool protocols used by HYMET.", "Protocol", [
        { id: "hype-asset", title: "HYPE quote asset", facts: [["Quote", "HYPE only"], ["Mint", "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g"], ["Token program", "Standard SPL Token"], ["Decimals", "9"]], paragraphs: ["HYMET validates the configured HYPE mint and token account before constructing launch transactions. HYPE is the quote asset; SOL may still be needed for transaction fees and account rent."] },
        { id: "meteora-protocols", title: "Meteora DBC and DAMM v2", paragraphs: ["HYMET uses Meteora's Dynamic Bonding Curve for the initial HYPE-paired market and configures DAMM v2 as the migration destination. Fee selection, pool settings, and recipients are validated when a transaction is prepared and again during launch confirmation.", "For migration status, HYMET checks the DBC state and verifies the DAMM v2 destination owner, account layout, and token pair. Unsupported or mismatched account state is not treated as a verified migration."] },
      ]),
      article("security-authorities", "Security & Authorities", "Who controls what, what has been verified on Mainnet, and what has not.", "Protocol", [
        { id: "wallet-signing", title: "Wallet signing", paragraphs: ["The connected wallet signs its own launch, trade, and claim transactions in Phantom. HYMET does not ask for a private key or recovery phrase. Read the network, recipient, and amounts in the wallet prompt before approving. Holder payouts are sent by the keeper and need no holder signature."] },
        { id: "roles", title: "Authority roles", facts: [["Mint and freeze authorities", "Verified as revoked before launch registration"], ["Creator", "Claims the creator share of its own launch; cannot change the split"], ["Platform fee recipient", "Receives only the 20% HYMET share"], ["Keeper", "Funds and closes payout rounds from the holder pool; cannot reach creator or HYMET funds"], ["Program upgrade authority", "Can upgrade the distributor and rotate the keeper key; upgrades are public on-chain"]], paragraphs: ["Wallet addresses, program IDs, and authority roles are different things. This documentation does not publish operational wallet identities."] },
        { id: "distributor-program", title: "Distributor program", facts: [["Mainnet program", "9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px"], ["Upgradeable", "Yes"], ["Build", "Reproducible"], ["Review", "Internal security review; no external audit yet"]], paragraphs: ["Fee math and account checks run on-chain. After each transfer the program confirms that its vault still covers everything owed. Each payout group can be paid only once, only to the wallet's canonical HYPE account, and never beyond the funded amount."] },
        { id: "verified-on-mainnet", title: "Verified on Mainnet", paragraphs: ["These flows have run on Mainnet with real HYPE, on HYMET's own test tokens, and the results matched on-chain records. Distributor launches used a 50/50 split at 1% and 2% trading fees."], bullets: [
          "Launches through the distributor and the native route.",
          "Buying and selling on Meteora DBC with Phantom.",
          "Keeper settlement of DBC fees, including the 20% HYMET share and the creator and holder split.",
          "Creator claims from the distributor.",
          "Funded holder payouts to wallets that already had a HYPE account, on two tokens.",
          "Recording carried amounts for wallets below their minimum, with their original balances proven against the on-chain snapshot.",
          "Exact reconciliation of chain state, database records, and wallet payments.",
        ] },
        { id: "not-yet-on-mainnet", title: "Validated only on Devnet, a local validator, or in tests", paragraphs: ["These flows are implemented, but have not yet run on Mainnet. Treat them as validated in test environments only."], bullets: [
          "Graduation, DBC-to-DAMM v2 migration, and canonical pool registration, at a 1% fee only. No other fee rate has been graduated in any environment.",
          "DAMM v2 trading and DAMM v2 fee settlement.",
          "Launches with a 0% creator and 100% holder split, and any split other than 50/50 through the distributor.",
          "Repeated payout rounds on one token at the 15-minute interval, and a carried amount growing until it is paid.",
          "Keeper-created HYPE accounts at the 0.05 HYPE minimum.",
          "Payment of carried amounts to wallets that have sold, which has been simulated only.",
          "Native-route creator claims and platform claims.",
        ], note: "Phantom is the only wallet tested in any environment." },
        { id: "availability-checks", title: "Transaction availability", paragraphs: ["Mainnet transaction construction is guarded by both server and public configuration. A page being available does not mean every transaction is enabled. HYMET also validates the configured HYPE mint, network, pool accounts, fee recipients, and confirmed launch state where applicable."], note: "These checks are not an external audit or a guarantee. Review each wallet request and verify addresses and signatures independently." },
      ]),
    ],
  },
  {
    name: "Resources",
    articles: [
      article("faq", "FAQ", "Quick answers about HYPE, fees, payouts, selling, and migration.", "Resources", [
        { id: "questions", title: "Frequently asked questions", bullets: [
          "Can I launch with SOL? No. HYMET uses HYPE as its only quote asset. SOL may still be needed for network fees and rent.",
          "Does HYMET charge a launch fee? The additional HYMET launch fee is 0 SOL. Solana costs, rent, and an optional initial buy are separate.",
          "Who receives the trading fee? On a DBC pool, Meteora takes 20%. Of the rest, HYMET receives 20%, and the creator and holders share 80% as chosen at launch.",
          "Can a creator change the split after launch? No. It is fixed at launch.",
          "Do holders need to claim? No. Eligible payouts are sent automatically in HYPE, and holders do not stake, lock, or sign anything.",
          "Will I be paid every 15 minutes? Not necessarily. Fifteen minutes is the shortest gap between rounds. A payout needs settled fees, a round that runs, and your amount reaching your minimum.",
          "What is the minimum payout? 0.01 HYPE if your wallet already has a HYPE account, or 0.05 HYPE if the keeper must create one. Smaller amounts carry over.",
          "Do I lose carried rewards if I sell? No. A carried amount stays recorded under your wallet and can be paid once it reaches your minimum. You earn no share of fees allocated at snapshots after you sell.",
          "Do tokens held in a pool or staking protocol earn rewards? Generally no. Accounts owned by program addresses are excluded from snapshots.",
          "How do creators get paid? In a launch with a holder share, the creator claims on the Fees & Rewards page. Payout minimums do not apply to creator claims.",
          "What happens to fees after graduation? They continue under the same split. This path has been validated on Devnet and a local validator, not yet on Mainnet.",
          "Does reaching the curve threshold mean migration is finished? No. HYMET reports a verified migration only after checking on-chain destination state.",
          "Are HYMET buybacks and burns already operating? They are manual, not automated, and this documentation does not claim that any have taken place. The platform allocation is designated for that intended use.",
          "Has the distributor been audited? It has an internal security review and a reproducible build, but no external audit yet.",
        ] },
      ]),
      article("official-links", "Official Links", "Open HYMET features and the configured ecosystem resources.", "Resources", [
        { id: "hymet-pages", title: "HYMET pages", paragraphs: ["Use these links to open the current application features. External links open in a separate tab so you can confirm the destination domain before connecting a wallet."], bullets: ["Launch Studio — create and review a HYPE-paired token.", "Explore — search confirmed public launch records.", "Fees & Rewards — review verified fee activity, creator claims, holder payouts, and carried amounts."] },
        { id: "ecosystem", title: "Ecosystem resources", bullets: ["Meteora — protocol information and ecosystem resources.", "Phantom — official wallet download.", "HYPE source registry — token-pairing reference used by HYMET."] },
      ]),
    ],
  },
];

export const docsArticles = docsGroups.flatMap((group) => group.articles);
export const findDoc = (slug: string) => docsArticles.find((item) => item.slug === slug);
export const docHref = (slug: string) => slug ? `/docs/${slug}` : "/docs";
