# Keeper

The keeper is a server process that completes the parts of a launch's life no user transaction covers: migrating a
graduated curve, registering the canonical DAMM v2 pool, collecting fees, and paying holders.

```bash
npm run rewards:keeper                                  # plan and simulate only
npm run rewards:keeper -- --send                        # broadcast (needs the keeper's own Mainnet settings on)
npm run rewards:keeper -- --send --payout-interval-minutes=15 --min-payout=<base units>
```

The keeper reads its own environment, separate from the web app's. In production its Mainnet settings and `--send` are
on, so it keeps settling fees, paying rounds and migrating completed curves for existing distributor tokens while the web
app's launches, trading and claims are closed.

## One run, per distributor token

```mermaid
flowchart TD
    A[Finish or close any open payout round] --> B{Curve complete?}
    B -- yes --> C[Migrate DBC → DAMM v2]
    B -- no --> D
    C --> D[Settle: drain DBC partner fees, register the canonical DAMM v2 pool, settle every fee-pool position with pending fees]
    D --> E{Holder pool ≥ minimum and 15 min since the last snapshot?}
    E -- no --> Z[Done]
    E -- yes --> F[Snapshot holders at one slot]
    F --> G[Plan payouts, carry small amounts]
    G --> H{Keeper SOL covers the round?}
    H -- no --> X[Stop: top-up alert]
    H -- yes --> I[Fund epoch with Merkle root]
    I --> J[Push every chunk]
    J --> K[Close epoch, index]
```

Every step resumes from chain state, so a failed or interrupted run is simply finished by the next one.

- **Settlement** is skipped when nothing is collectible. Up to 6 settlements run per token per run, so extra
  positions someone adds to the fee pool cannot exhaust the keeper's SOL.
- **Snapshots** run at most once per `--payout-interval-minutes` (default 15, measured from the last snapshot's block time) per token, while migration and settlement
  run on every tick. A token's first payout has no waiting period.
- **SOL guard.** A round is funded only if the keeper holds its planned fees, new holder-account rent and epoch rent,
  plus 0.005 SOL of headroom.
- **Transactions** carry a priority fee (`HYMET_KEEPER_PRIORITY_MICROLAMPORTS`, default 20,000) and are rebroadcast
  with the same signature until confirmed or expired; a broadcast is never replayed after a transport error.

## Instant graduation

When a buy completes a curve, the app records a `graduation_requests` row. Its trigger issues
`NOTIFY hymet_graduation`; the watcher (`scripts/graduation-watcher.mjs`) wakes and runs the keeper for that mint only,
serialized with the periodic run by a file lock. The periodic run remains the fallback.

## Scheduling

| Unit | Schedule |
|---|---|
| Keeper | Every 5 minutes, after the indexer |
| Graduation watcher | Long-running |
| Alerts (`scripts/keeper-alerts.mjs`) | Every 5 minutes |

Run them under a dedicated system user that alone can read the keeper key, with a read-only code tree and only the
state directory writable.

## Alerts

`scripts/keeper-alerts.mjs` prints one JSON line, exits 1 when an alert fires, can POST to `HYMET_ALERT_WEBHOOK_URL` and
can notify Telegram (`HYMET_TELEGRAM_BOT_TOKEN`, `HYMET_TELEGRAM_CHAT_ID`):

| Alert | Condition |
|---|---|
| `keeper-failed` / `keeper-stale` / `keeper-no-status` | Last full run had errors, or none finished in 30 minutes |
| `keeper-unit-down` | A unit named in `HYMET_ALERT_UNITS` is not active |
| `keeper-sol-low` | Keeper balance below 0.05 SOL |
| `settlement-stalled` | Fee settlement for a token keeps failing |
| `migration-stalled` | Migration keeps failing, or a curve completed 30 minutes ago with no registered DAMM v2 pool |
| `payout-overdue` | Holder HYPE that can be paid has waited more than 1 hour since the last snapshot, and is not carrying below the minimum |
| `epoch-open-too-long` | A payout round open for more than 1 hour |
| `unexpected-epoch` | A round funded on-chain that matches no keeper-prepared root: treat as a keeper-key compromise, stop the keeper and rotate the key in the owner console |
| `alert-check-failed` | The health check itself cannot reach the database or RPC |
| `seller-proof-mismatch` | A seller's stored balance or epoch disagrees with the snapshot hash committed on-chain. Nobody is paid from that proof: treat as database corruption or tampering and run the reconciliation |
| `seller-proof-unavailable` | A seller is due payment but its proof could not be attempted (no origin, pruned balances, RPC). It stays carried |

Telegram notifies when an alert starts, reminds every 6 hours while it lasts (hourly for `unexpected-epoch` and `seller-proof-mismatch`) and reports
recovery. Conditions that usually clear by themselves wait first: 10 minutes for a failed run or a stopped unit, 15 for
migration and a broken health check, 30 for settlement and an unavailable seller proof, 60 for an overdue payout. Messages are plain text with URLs and
credentials removed. A silent message every 24 hours (`HYMET_ALERT_HEARTBEAT_HOURS`) shows the alerting itself is alive;
if it stops arriving, the server cannot send alerts at all.

## Costs

With up to 6 holders, settlement plus one payout round costs about 0.00004 SOL, plus about 0.000009 SOL per extra 6
holders. At one round every 15 minutes that is up to about 0.004 SOL per token per day; a round only runs when a holder has
reached the payout minimum. After a snapshot that finds nobody to pay, the keeper does not repeat it until new HYPE has
reached the pool and 15 minutes have passed, or 6 hours have passed. Creating a holder's HYPE account costs about 0.0015 SOL of rent, paid once by the
keeper, so a holder must be owed at least 0.05 HYPE before the keeper creates one.

### Wallets that sold

This path has been simulated, but not yet paid on Mainnet.

The program requires a token balance above zero in every payout entry and cannot read past balances. A wallet that no
longer holds is paid with its true balance at the snapshot that allocated its carry, under the same minimums. Before
paying, the keeper reads that snapshot's hash from the confirmed funding transaction, recomputes it from the stored
balances and requires the wallet's balance to match. An unproven wallet stays carried and is logged as
`seller carry not paid` and in a Telegram alert. A failure stays reported until the next snapshot rechecks it, which is
at most 6 hours for an unchanged pool. A round that pays such a wallet commits its origin epoch, slot, balance and amount in
`snapshot_hash` (`snapshotCommitment`), because a payout entry has no field for them.

Run `scripts/reconcile-holder-rewards.ts <mint>` to compare chain, database and wallet payments to the base unit. It is
read-only. `scripts/backfill-snapshot-balances.ts` records balances for a snapshot taken before origins were stored,
and refuses unless they reproduce the on-chain hash.

## RPC

The holder snapshot is a `getProgramAccounts` query on the SPL Token program filtered by mint. Public endpoints may
limit or refuse this query, so use a dedicated provider and set `HYMET_KEEPER_RPC_URL`. Production uses a dedicated
provider.

## Verification status

**Verified on Mainnet**, with real HYPE on HYMET's own test tokens:

- Launches through the distributor (50/50 split, at 1% and 2% trading fees) and the native route
- Buying and selling on Meteora DBC with Phantom
- Keeper settlement of DBC fees, including the 20% HYMET share and the creator and holder split
- Creator claims from the distributor
- Funded holder payouts to wallets that already had a HYPE account: one round on each of two tokens
- Recording carried amounts for wallets below their minimum, with original balances proven against the on-chain snapshot
- Exact reconciliation of chain state, database records and wallet payments

**Devnet, local validator or tests only**, not yet run on Mainnet:

- Graduation, DBC-to-DAMM v2 migration and canonical pool registration, at a 1% fee only
- DAMM v2 trading and DAMM v2 fee settlement
- Any distributor split other than 50/50, including 0% creator / 100% holders
- Repeated payout rounds on one token at the 15-minute interval, and a carried amount growing until it is paid
- Keeper-created HYPE accounts at the 0.05 HYPE minimum
- Paying carried amounts to wallets that have sold (simulated only)
- Native-route creator claims and platform claims

Phantom is the only wallet tested in any environment.
