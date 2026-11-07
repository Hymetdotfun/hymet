# Changelog

Notable changes to HYMET, newest first. Dates are UTC. Each entry links to the commits that made it.

## v1.0.0: Public Mainnet Launch (2026-11-07)

hymet.fun opened launches, trading and creator claims on Solana Mainnet at 16:26 UTC. $HYMET, HYMET's own token, was
launched through the site at 16:43 UTC.

### Added

- **$HYMET Burn Tracker** on the dashboard. Total burned is the original 1,000,000,000 supply minus the finalized on-chain
  supply. Each SPL burn instruction, top-level or inner, is indexed once by signature and instruction path, and a
  checkpoint is saved only when the indexed burns match the supply reduction exactly. Team buyback burns (signed by the
  HYMET team wallet) are kept separate from other on-chain burns, and transfers to dead wallets are never counted.
  Database migration `012_token_burns` adds two tables, with a rollback script.
  ([465c883](https://github.com/Hymetdotfun/hymet/commit/465c883), [ed1777c](https://github.com/Hymetdotfun/hymet/commit/ed1777c))
- **$HYMET as the official token in Explore.** It is always the first card, with an animated ring, an Official badge and a
  pinned indicator, and the token API always includes it. Search and filters still apply, and it is never shown twice.
  ([70f7c4f](https://github.com/Hymetdotfun/hymet/commit/70f7c4f))
- **Token page overview** redesigned as two compact panels, Trading Fees and Token Information. Total trading fees and
  distributable fees after Meteora's share are shown separately, and only `http(s)` social links are rendered.
  ([eb31111](https://github.com/Hymetdotfun/hymet/commit/eb31111), [b887c24](https://github.com/Hymetdotfun/hymet/commit/b887c24),
  [a173893](https://github.com/Hymetdotfun/hymet/commit/a173893), [335fd05](https://github.com/Hymetdotfun/hymet/commit/335fd05))
- **Open Graph and X card** for sharing hymet.fun. ([58a9486](https://github.com/Hymetdotfun/hymet/commit/58a9486))

### Fixed

- **Creator Earnings claims no longer fail with "Blockhash expired".** A reviewed DBC or DAMM v2 claim now gets the latest
  blockhash just before Phantom signs. Every other byte of the message must match the reviewed one. A claim whose
  blockhash expires during a slow approval is never sent, and is cleared once it provably cannot land.
  ([9ca9ff7](https://github.com/Hymetdotfun/hymet/commit/9ca9ff7))

### Changed

- **Docs: Buyback & Burn is manual.** HYMET's 20% platform allocation is designated for buying back and burning $HYMET by
  hand; nothing buys or burns automatically. ([c118579](https://github.com/Hymetdotfun/hymet/commit/c118579))

## Public site with Mainnet transactions closed (2026-11-05 to 2026-11-06)

- **Launching Soon** for closed features, with the Mainnet gate enforced on the server for claims and launch
  confirmation as well as in the browser. ([33dda11](https://github.com/Hymetdotfun/hymet/commit/33dda11))
- **Token exclusions** moved to a private server setting, and test fixtures replaced with generic values.
  ([9f1865c](https://github.com/Hymetdotfun/hymet/commit/9f1865c), [19ed836](https://github.com/Hymetdotfun/hymet/commit/19ed836))
- **Documentation** updated to match the deployed holder rewards system and Mainnet verification status, and the README's
  launch sequence diagram fixed so GitHub renders it.
  ([c836d97](https://github.com/Hymetdotfun/hymet/commit/c836d97), [52f2bbc](https://github.com/Hymetdotfun/hymet/commit/52f2bbc),
  [2d6eddf](https://github.com/Hymetdotfun/hymet/commit/2d6eddf))
- **Site polish:** HYMET favicons, consistent fee card spacing, an animated docs background, and cleaner calls to action.
  ([7547a18](https://github.com/Hymetdotfun/hymet/commit/7547a18), [9d89a8f](https://github.com/Hymetdotfun/hymet/commit/9d89a8f),
  [cd753eb](https://github.com/Hymetdotfun/hymet/commit/cd753eb), [e52f16c](https://github.com/Hymetdotfun/hymet/commit/e52f16c))

## Mainnet readiness (2026-11-03 to 2026-11-04)

- **Production hardening:** framing protection, a same-origin check on the RPC proxy, a shared token feed and safe error
  messages. ([c4e8b61](https://github.com/Hymetdotfun/hymet/commit/c4e8b61))
- **Holder rewards:**
  - Payouts run every 15 minutes without redundant snapshots ([42a2d7f](https://github.com/Hymetdotfun/hymet/commit/42a2d7f)).
  - Sellers are paid their carried amount, proven against the on-chain snapshot ([c495142](https://github.com/Hymetdotfun/hymet/commit/c495142)).
  - Failed seller proofs raise keeper alerts, and migration 011 has a rollback ([b749d32](https://github.com/Hymetdotfun/hymet/commit/b749d32)).
- **Launch flow:** tokens are identified by mint, the launch needs one approval, and the allocation slider follows the
  distributor. Launch costs are now accurate, keeper errors show more detail, and fewer RPC calls are made.
  ([fa1f398](https://github.com/Hymetdotfun/hymet/commit/fa1f398), [e6369ef](https://github.com/Hymetdotfun/hymet/commit/e6369ef))
- **Wallet signing:**
  - Launches, swaps and fee claims set an explicit priority price, so Phantom signs exactly the reviewed message.
  - The only changes Phantom may add are Lighthouse assertions.

  ([028b9c7](https://github.com/Hymetdotfun/hymet/commit/028b9c7), [73c8c6d](https://github.com/Hymetdotfun/hymet/commit/73c8c6d),
  [7379830](https://github.com/Hymetdotfun/hymet/commit/7379830), [8a2de63](https://github.com/Hymetdotfun/hymet/commit/8a2de63))
- **Operations:** platform claims are decided per launch, keeper alerts are delivered by Telegram, and the production
  manifest and health status are accurate.
  ([2af6875](https://github.com/Hymetdotfun/hymet/commit/2af6875), [898c502](https://github.com/Hymetdotfun/hymet/commit/898c502),
  [d4a8dfa](https://github.com/Hymetdotfun/hymet/commit/d4a8dfa))
- **Public documentation and license:** README, architecture and technical docs, published under Apache-2.0.
  ([ab6831d](https://github.com/Hymetdotfun/hymet/commit/ab6831d), [97adf16](https://github.com/Hymetdotfun/hymet/commit/97adf16))

## Not yet verified on Mainnet

These have run on Devnet, a local validator or in tests only:
- graduation and DAMM v2
- distributor splits other than 50/50
- repeated payout rounds
- native-route creator claims and platform claims

See the README's [What has been verified on Mainnet](README.md#what-has-been-verified-on-mainnet).
