<p align="center">
  <img width="2086" height="754" alt="HYMET: Where HYPE launches" src="https://github.com/user-attachments/assets/df606861-946c-4b85-87e1-25069ec48c72" />
</p>

<p align="center">
  <b>A HYPE-only token launchpad on Solana.</b><br>
  Fixed-supply launches on a Meteora Dynamic Bonding Curve, automatic migration to a permanently locked
  Meteora DAMM v2 pool, and trading fees split on-chain between HYMET, creators and holders.
</p>

<p align="center">
  <a href="https://x.com/Hymetdotfun"><img alt="X: @Hymetdotfun" src="https://img.shields.io/badge/X-@Hymetdotfun-101211?style=flat-square&logo=x&logoColor=8ff5db"></a>
  <img alt="Network: Solana Mainnet" src="https://img.shields.io/badge/network-Solana%20Mainnet-101211?style=flat-square&logo=solana&logoColor=8ff5db">
  <img alt="Quote asset: HYPE" src="https://img.shields.io/badge/quote-HYPE-101211?style=flat-square&labelColor=101211&color=8ff5db">
  <img alt="Program: Anchor 0.31.1" src="https://img.shields.io/badge/program-Anchor%200.31.1-101211?style=flat-square">
  <img alt="App: Next.js 16" src="https://img.shields.io/badge/app-Next.js%2016-101211?style=flat-square&logo=nextdotjs">
</p>

---

## Contents

- [What HYMET is](#what-hymet-is)
- [How a launch works](#how-a-launch-works)
- [Where the fees go](#where-the-fees-go)
- [Architecture](#architecture)
- [On-chain addresses](#on-chain-addresses)
- [Verify the deployed program](#verify-the-deployed-program)
- [Repository map](#repository-map)
- [Run it locally](#run-it-locally)
- [Documentation](#documentation)
- [Security](#security)
- [License](#license)

## What HYMET is

HYMET launches Solana tokens paired only with **HYPE**. Every launch uses the same fixed recipe, enforced by the app
and checked on-chain, so traders can compare launches like for like:

| | |
|---|---|
| **Supply** | Fixed at 1,000,000,000 tokens, 9 decimals; token authority immutable, no HYMET launch fee |
| **Curve** | Meteora Dynamic Bonding Curve (DBC), starting at a 33.5 HYPE market cap |
| **Graduation** | At a 447 HYPE market cap (96.07 HYPE raised), liquidity migrates to Meteora DAMM v2 |
| **Liquidity after graduation** | 100% permanently locked; nobody can withdraw it |
| **Trading fee** | Chosen per launch between 0.25% and 3% (default 1%), paid in HYPE before and after graduation |
| **Fee split** | Fixed per launch at creation and enforced on-chain (see [below](#where-the-fees-go)) |

Thresholds are fixed in HYPE, so a launch graduates on the same HYPE amount whatever HYPE's USD price is.
[Launch economics](docs/LAUNCH-ECONOMICS.md) has the exact curve figures.

## How a launch works

```mermaid
sequenceDiagram
    autonumber
    actor C as Creator (Phantom)
    participant A as HYMET app
    participant DBC as Meteora DBC
    participant K as Keeper
    participant D as DAMM v2
    C->>A: Name, ticker, artwork, fee, split
    A->>A: Record the launch (wallet-signed, names need not be unique)
    A->>C: Unsigned launch transaction for review
    C->>DBC: Sign: create token, curve config and pool (+ optional first buy)
    A->>A: Verify on-chain state, index the launch
    Note over DBC: Traders buy and sell on the curve, fees accrue in HYPE
    DBC-->>A: Curve complete (96.07 HYPE in the pool)
    A->>K: Graduation request (instant, via Postgres NOTIFY)
    K->>DBC: Migrate
    DBC->>D: Liquidity moves to DAMM v2, LP positions permanently locked
    K->>D: Register the canonical pool, settle fees
    Note over D: Trading continues on DAMM v2, fees keep flowing
```

## Where the fees go

Meteora keeps its protocol share of every trading fee. HYMET's share of the rest is **always 20%**; the remainder
goes to the creator, or is split between the creator and the token's holders.

```mermaid
flowchart LR
    T[Trade on DBC or DAMM v2] --> F[Trading fee in HYPE]
    F --> M[Meteora protocol share]
    F --> R[Remaining fee]
    R --> H[HYMET 20%]
    R --> X[80%]
    X --> C[Creator: chosen share]
    X --> HO[Holders: the rest, paid automatically]
```

HYMET runs in two modes:

| Mode | Status | How the 80% is handled |
|---|---|---|
| **Native split** | Active | Meteora pays HYMET (20%) and the creator (80%) directly; after graduation each owns a permanently locked LP position |
| **Distributor** | Deployed and initialized; verified in private Mainnet testing; public launches not yet open | All fees go to the HYMET distributor program, which pays HYMET 20%, lets the creator claim their share and pushes the holders' share to holders about every 15 minutes, once amounts reach the payout minimum |

The distributor holds no keys of its own: its fee pool is a program-derived address that can only claim Meteora fees
and pay them out by the fixed rules. See [Distributor program](docs/DISTRIBUTOR.md).

## Architecture

```mermaid
flowchart TB
    subgraph Browser
      W[Phantom wallet]
      UI[HYMET web app<br/>Next.js 16 / React 19]
    end
    subgraph Server["HYMET server"]
      API[API routes<br/>launch, fees, graduation, owner]
      DB[(PostgreSQL<br/>launches, fees, epochs)]
      IDX[Distributor indexer]
      KEEP[Payout keeper<br/>every 5 min]
      WATCH[Graduation watcher<br/>LISTEN/NOTIFY]
      ALERT[Keeper alerts]
    end
    subgraph Solana["Solana Mainnet"]
      DBC[Meteora DBC]
      DAMM[Meteora DAMM v2]
      DIST[HYMET distributor<br/>9X9f…239Px]
      HYPE[HYPE mint]
    end
    UI <--> W
    UI --> API
    API --> DB
    W -- signs --> DBC
    W -- signs --> DAMM
    API -- reads --> DBC
    API -- reads --> DAMM
    WATCH -- runs --> KEEP
    KEEP --> DBC
    KEEP --> DAMM
    KEEP --> DIST
    IDX --> DIST
    IDX --> DB
    KEEP --> DB
    ALERT --> DB
    ALERT --> DIST
```

- **The app never holds user keys.** The server builds and simulates unsigned transactions; Phantom signs; the app
  checks the signed message against the one you reviewed before it is sent. It must be byte-for-byte identical, except
  that swaps and fee claims accept Lighthouse assertions added by Phantom; every reviewed instruction must stay unchanged.
- **The keeper holds one narrow key**: the distributor's snapshot authority. It can fund holder payout rounds from
  fees already collected for holders, and nothing else. See [Keeper](docs/KEEPER.md).

## On-chain addresses

| What | Address |
|---|---|
| HYMET distributor program | [`9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px`](https://solscan.io/account/9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px) |
| Distributor config | [`5QMrhkg36hnJVBubARNLrL8vPaCb9koRYLeffVc8GNHG`](https://solscan.io/account/5QMrhkg36hnJVBubARNLrL8vPaCb9koRYLeffVc8GNHG) |
| Upgrade authority / admin | [`9G9v3Ax4K2prmVQfDzp2HY6YYZ5UFmCo24761pgEmMo7`](https://solscan.io/account/9G9v3Ax4K2prmVQfDzp2HY6YYZ5UFmCo24761pgEmMo7) |
| HYMET platform fee wallet | [`7sAoyG3ZdewKrZKLzU8VTpfzNh6YuJKQAgnWjgjSqPEs`](https://solscan.io/account/7sAoyG3ZdewKrZKLzU8VTpfzNh6YuJKQAgnWjgjSqPEs) |
| Keeper (snapshot authority) | [`GHZHuBqZvmixBDHsApwEJeW3dCgR1p39UPNszHeuoL8S`](https://solscan.io/account/GHZHuBqZvmixBDHsApwEJeW3dCgR1p39UPNszHeuoL8S) |
| HYPE mint | [`98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g`](https://solscan.io/token/98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g) |
| Meteora DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| Meteora DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |

These values are pinned in [`config/production.json`](config/production.json); the app and keeper refuse to run if
the chain disagrees.

## Verify the deployed program

The deployed distributor is reproducible from this repository, byte for byte:

```bash
solana program dump 9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px deployed.so -u mainnet-beta
sha256sum deployed.so
# fda10de4da728442da4a42a63bb1f5d8df614e49f8421c656ee2ca67f3be3e7b  (509,112 bytes)
```

[Verify the build](docs/VERIFY-BUILD.md) shows how to rebuild that exact binary from source with Solana CLI 2.2.1.

## Repository map

```text
app/                Next.js routes: launch, explore, token pages, fees, dashboard, docs, owner console, API
components/         UI components (launch form, trade panel, fee ledger, owner console, ...)
lib/                Core logic: DBC/DAMM v2 transactions, fee accounting, distributor client, keeper, indexer
programs/           HYMET distributor (Anchor 0.31.1, Rust)
migrations/         PostgreSQL schema, applied in order by `npm run db:migrate`
scripts/            Keeper, indexer, graduation watcher, alerts, deployment and verification tooling
config/             production.json: the pinned Mainnet addresses and reviewed program hash
tests/              Vitest suite (TypeScript) covering transactions, fees, keeper, indexer and guards
vendor/             Bounds-checked pure-JS replacement for bigint-buffer (GHSA-3gc7-fjrx-p6mg)
docs/               Technical documentation
```

## Run it locally

Requirements: Node.js 20 or newer (production runs 24), PostgreSQL 16, and (for the program) Rust with Solana CLI
2.2.1.

```bash
npm ci                       # .npmrc keeps install scripts off (ignore-scripts=true)
cp .env.example .env.local   # fill in DATABASE_URL and the public addresses; Mainnet stays off by default
npm run db:migrate
npm run dev                  # http://127.0.0.1:4173
npm test                     # Vitest
npm run typecheck && npm run lint
```

Mainnet transactions stay disabled until both `NEXT_PUBLIC_ENABLE_MAINNET` and `ENABLE_MAINNET` are `true`. For
end-to-end testing against a local Mainnet fork, see [Local test network](docs/LOCAL-TEST-NETWORK.md);
[Development](docs/DEVELOPMENT.md) covers the rest.

## Documentation

| Document | What it covers |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Components, data flow, trust boundaries, transaction safety |
| [Distributor program](docs/DISTRIBUTOR.md) | Accounts, instructions, fee math, holder payouts, security properties |
| [Keeper](docs/KEEPER.md) | Graduation, settlement, snapshots, payouts, scheduling, alerts |
| [Launch economics](docs/LAUNCH-ECONOMICS.md) | Curve parameters, graduation thresholds, costs |
| [Verify the build](docs/VERIFY-BUILD.md) | Reproduce the deployed binary from source |
| [Development](docs/DEVELOPMENT.md) | Setup, configuration, tests, scripts |
| [Allocation API](docs/ALLOCATION-API.md) | Creator/holder allocation inputs and checks |
| [Local test network](docs/LOCAL-TEST-NETWORK.md) | Running the app against a local Mainnet fork |

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md). Do not open public issues for security
problems.

The distributor program has had an internal security review and a reproducible build. It has **not** had an external
audit. Trading launched tokens carries market risk; nothing here is financial advice.

### What has been verified on Mainnet

| Flow | Evidence |
|---|---|
| Launch with a creator/holder split and first buy, DBC settlement, automatic holder payout, creator claim, and a sell through Phantom | Private Mainnet test |
| Graduation to DAMM v2, DAMM v2 trading and settlement | **Devnet and local validator only**, at a 1% fee. Not yet run on Mainnet, and no other fee rate has graduated |
| Buying through the app and native-split creator and platform claims through Phantom | Not yet tested on Mainnet |

## License

HYMET is licensed under the [Apache License 2.0](LICENSE). Third-party material in this repository keeps its own
license; see [NOTICE](NOTICE).
