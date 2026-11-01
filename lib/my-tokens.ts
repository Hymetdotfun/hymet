import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { Buffer } from "buffer";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import bs58 from "bs58";
import {
  readCreatorFees,
  knownCreatorPools,
  claimRecord,
  type FeeView,
} from "./creator-fees";
import { loadRecovery } from "./recovery";
import { socialLinks } from "./socials";
import { limitedBody } from "./http";
import type { Network } from "./transactions";
type Store = Pick<Storage, "getItem" | "setItem">;
export type LastClaim = {
  signature: string;
  slot: number;
  blockTime: number | null;
};
type Entry = { pool: string; lastClaim?: LastClaim };
const key = (network: Network, owner: string) =>
  `dbc-my-tokens-v1:${network}:${owner}`;
export function savedTokens(
  storage: Pick<Storage, "getItem">,
  network: Network,
  owner: string,
): Entry[] {
  const raw = storage.getItem(key(network, owner));
  if (!raw) return [];
  const r = JSON.parse(raw);
  if (
    r.version !== 1 ||
    r.network !== network ||
    r.owner !== owner ||
    !Array.isArray(r.tokens) ||
    r.tokens.length > 100
  )
    throw Error(
      "Invalid My Tokens storage; original recovery records were not changed",
    );
  return r.tokens.map((t: Entry) => ({
    pool: new PublicKey(t.pool).toBase58(),
    ...(t.lastClaim ? { lastClaim: t.lastClaim } : {}),
  }));
}
export function discoverTokenPools(
  storage: Pick<Storage, "getItem">,
  network: Network,
  owner: string,
) {
  const recovery = loadRecovery(storage, network, owner);
  return [
    ...new Set([
      ...savedTokens(storage, network, owner).map((t) => t.pool),
      ...knownCreatorPools(storage, network, owner),
      ...(recovery ? [recovery.pool] : []),
    ]),
  ];
}
function saveToken(
  storage: Store,
  network: Network,
  owner: string,
  view: TokenView,
) {
  if (view.network !== network || view.creator !== owner)
    throw Error("Pool belongs to a different network or creator wallet");
  const list = savedTokens(storage, network, owner),
    old = list.find((t) => t.pool === view.pool);
  const entry = {
    pool: view.pool,
    lastClaim: view.lastClaim || old?.lastClaim,
  };
  storage.setItem(
    key(network, owner),
    JSON.stringify({
      version: 1,
      network,
      owner,
      tokens: [...list.filter((t) => t.pool !== view.pool), entry].slice(-100),
    }),
  );
}
export function tokenExplorer(
  network: Network,
  type: "account" | "tx",
  address: string,
) {
  return `https://solscan.io/${type}/${encodeURIComponent(address)}${network === "devnet" ? "?cluster=devnet" : ""}`;
}
export function selectCreatorFees(
  view: FeeView,
  network: Network,
  select: (pool: string) => void,
) {
  if (view.network !== network)
    throw Error("Network changed; refresh the token first");
  select(new PublicKey(view.pool).toBase58());
}
export function publicTokenUrl(value: string) {
  try {
    const text = value.startsWith("ipfs://")
      ? `https://ipfs.io/ipfs/${value.slice(7).replace(/^ipfs\//, "")}`
      : value;
    const validated = socialLinks({ website: text }).website;
    const url = new URL(validated);
    if (url.port || url.search || url.hash) return;
    return url.href;
  } catch {
    return;
  }
}
async function tokenLogo(c: Connection, mint: string) {
  try {
    const [address] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        METAPLEX_PROGRAM_ID.toBuffer(),
        new PublicKey(mint).toBuffer(),
      ],
      METAPLEX_PROGRAM_ID,
    );
    const a = await c.getAccountInfo(address, "confirmed");
    if (
      !a?.owner.equals(METAPLEX_PROGRAM_ID) ||
      a.data[0] !== 4 ||
      !new PublicKey(a.data.subarray(33, 65)).equals(new PublicKey(mint))
    )
      return;
    let offset = 65,
      uri = "";
    for (const max of [32, 10, 200]) {
      const size = a.data.readUInt32LE(offset);
      offset += 4;
      if (size > max || offset + size > a.data.length) return;
      uri = a.data
        .subarray(offset, offset + size)
        .toString("utf8")
        .replace(/\0+$/, "");
      offset += size;
    }
    const url = publicTokenUrl(uri);
    if (!url) return;
    const r = await fetch(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return;
    const metadata = JSON.parse(
      new TextDecoder().decode(await limitedBody(r, 65536)),
    );
    return typeof metadata.image === "string"
      ? publicTokenUrl(metadata.image)
      : undefined;
  } catch {
    return;
  }
}
async function verifiedClaim(
  c: Connection,
  owner: string,
  pool: string,
  signature: string,
): Promise<LastClaim | undefined> {
  try {
    if (bs58.decode(signature).length !== 64) return;
    const tx = await c.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta || tx.meta.err) return;
    const m = tx.transaction.message;
    const keys =
      m.version === "legacy"
        ? m.accountKeys
        : [
            ...m.staticAccountKeys,
            ...(tx.meta.loadedAddresses?.writable || []),
            ...(tx.meta.loadedAddresses?.readonly || []),
          ];
    const instructions =
      m.version === "legacy"
        ? m.instructions.map((ix) => ({
            programIdIndex: ix.programIdIndex,
            accountKeyIndexes: ix.accounts,
            data: Buffer.from(bs58.decode(ix.data)),
          }))
        : m.compiledInstructions;
    const sdk = new DynamicBondingCurveClient(c);
    for (const ix of instructions) {
      if (!keys[ix.programIdIndex]?.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
        continue;
      const decoded = new BorshInstructionCoder(sdk.program.idl).decode(
        Buffer.from(ix.data),
      );
      if (
        !decoded ||
        !["claimCreatorTradingFee", "claimCreatorTradingFee2"].includes(
          decoded.name,
        )
      )
        continue;
      const def = sdk.program.idl.instructions.find(
        (d) => d.name === decoded.name,
      )!;
      const poolIndex = def.accounts.findIndex((a) => a.name === "pool"),
        creatorIndex = def.accounts.findIndex((a) => a.name === "creator");
      const actualCreatorIndex = ix.accountKeyIndexes[creatorIndex];
      if (
        poolIndex >= 0 &&
        creatorIndex >= 0 &&
        actualCreatorIndex < m.header.numRequiredSignatures &&
        keys[actualCreatorIndex]?.toBase58() === owner &&
        keys[ix.accountKeyIndexes[poolIndex]]?.toBase58() === pool
      )
        return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null };
    }
  } catch {
    /* Unavailable history is not a confirmed claim. */
  }
}
export type TokenView = FeeView & {
  progress?: number;
  logo?: string;
  lastClaim?: LastClaim;
};
export async function readToken(
  c: Connection,
  network: Network,
  pool: string,
  owner: string,
  storage: Pick<Storage, "getItem">,
): Promise<TokenView> {
  const view = await readCreatorFees(c, network, pool);
  if (view.creator !== owner)
    throw Error("Pool is not owned by the connected creator wallet");
  let progress: number | undefined;
  if (view.status === "active")
    try {
      const n = await new DynamicBondingCurveClient(
        c,
      ).state.getPoolQuoteTokenCurveProgress(pool);
      if (Number.isFinite(n) && n >= 0 && n <= 1) progress = n;
    } catch {
      /* No invented progress. */
    }
  const old = savedTokens(storage, network, owner).find(
    (t) => t.pool === view.pool,
  )?.lastClaim;
  const current = claimRecord(storage, network, owner);
  const candidates = [
    old?.signature,
    ...(current?.pool === view.pool ? [current.signature] : []),
  ].filter((s): s is string => !!s);
  let lastClaim: LastClaim | undefined;
  for (const signature of new Set(candidates)) {
    const confirmed = await verifiedClaim(c, owner, pool, signature);
    if (confirmed && (!lastClaim || confirmed.slot > lastClaim.slot))
      lastClaim = confirmed;
  }
  return { ...view, progress, lastClaim, logo: await tokenLogo(c, view.mint) };
}
export async function importToken(
  c: Connection,
  network: Network,
  pool: string,
  owner: string,
  storage: Store,
) {
  const view = await readToken(
    c,
    network,
    new PublicKey(pool).toBase58(),
    owner,
    storage,
  );
  saveToken(storage, network, owner, view);
  return view;
}
export async function refreshTokens(
  c: Connection,
  network: Network,
  owner: string,
  storage: Store,
  extraPools: string[] = [],
) {
  const pools = [
      ...new Set([
        ...discoverTokenPools(storage, network, owner),
        ...extraPools.map((p) => new PublicKey(p).toBase58()),
      ]),
    ],
    tokens: TokenView[] = [],
    errors: { pool: string; message: string }[] = [];
  for (const pool of pools)
    try {
      const view = await importToken(c, network, pool, owner, storage);
      tokens.push(view);
    } catch (e) {
      errors.push({
        pool,
        message: e instanceof Error ? e.message : "Pool/RPC unavailable",
      });
    }
  return { tokens, errors };
}
