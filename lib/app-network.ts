// Runtime network policy. Historical network types/storage schemas remain intact.
export const APP_NETWORK = "mainnet-beta" as const;
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const APP_RPC_PATH = "/api/rpc?network=mainnet-beta";
export function assertAppNetwork(network: string) {
  if (network !== APP_NETWORK)
    throw Error("This launcher supports Solana Mainnet Beta only");
}

/**
 * Local test network (development only). A loopback solana-test-validator started from the Mainnet Meteora
 * fixtures (scripts/validator-fixture-start.cjs): same HYPE mint, Meteora programs and distributor program ID,
 * different genesis. It is requested only by NEXT_PUBLIC_HYMET_TEST_NETWORK=localnet (inlined into browser
 * bundles at build time) and is then the ONLY network the app talks to: every RPC call goes to
 * HYMET_TEST_RPC_URL and every genesis check expects NEXT_PUBLIC_HYMET_TEST_GENESIS. Any misconfiguration
 * disables all transactions instead of falling back to Mainnet.
 */
/**
 * Devnet test network (development only): the same guarded mode against public Devnet, for real Phantom signing
 * with the isolated Devnet distributor build. Mainnet HYPE does not exist on Devnet, so a Devnet test HYPE mint
 * (NEXT_PUBLIC_HYMET_TEST_HYPE_MINT, see lib/quote-assets.ts) is required. Only the public Devnet RPC and the
 * Devnet genesis are accepted; anything else disables transactions.
 */
export type TestNetwork = "localnet" | "devnet";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const MAINNET_HYPE = "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g";
const LOOPBACK_URL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;
export function testNetworkRequested() {
  return Boolean(process.env.NEXT_PUBLIC_HYMET_TEST_NETWORK);
}
/** Why the requested test network is unusable, or null when it is correctly configured. */
export function testNetworkProblem(): string | null {
  const genesis = process.env.NEXT_PUBLIC_HYMET_TEST_GENESIS;
  const network = process.env.NEXT_PUBLIC_HYMET_TEST_NETWORK;
  if (network !== "localnet" && network !== "devnet")
    return "only the localnet and devnet test networks are supported";
  if (!genesis || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesis) || genesis === MAINNET_GENESIS)
    return "NEXT_PUBLIC_HYMET_TEST_GENESIS must be the test network genesis hash (never Mainnet)";
  if (network === "devnet") {
    if (genesis !== DEVNET_GENESIS) return "NEXT_PUBLIC_HYMET_TEST_GENESIS must be the Devnet genesis hash";
    const mint = process.env.NEXT_PUBLIC_HYMET_TEST_HYPE_MINT || "";
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || mint === MAINNET_HYPE)
      return "NEXT_PUBLIC_HYMET_TEST_HYPE_MINT must be the Devnet test HYPE mint (never Mainnet HYPE)";
  }
  if (process.env.NEXT_PUBLIC_ENABLE_MAINNET === "true")
    return "Mainnet switches must stay off while the test network is active";
  if (typeof window !== "undefined")
    return LOOPBACK_HOST.test(window.location.hostname) ? null : "the test network is served only on localhost";
  if (process.env.VERCEL || process.env.VERCEL_ENV) return "the test network never runs on Vercel";
  if (process.env.ENABLE_MAINNET === "true") return "Mainnet switches must stay off while the test network is active";
  if (process.env.HYMET_TEST_NETWORK !== network) return "HYMET_TEST_NETWORK must match NEXT_PUBLIC_HYMET_TEST_NETWORK";
  if (network === "devnet")
    return process.env.HYMET_TEST_RPC_URL === DEVNET_RPC_URL ? null : `HYMET_TEST_RPC_URL must be ${DEVNET_RPC_URL}`;
  if (!LOOPBACK_URL.test(process.env.HYMET_TEST_RPC_URL || "")) return "HYMET_TEST_RPC_URL must be a loopback validator URL";
  return null;
}
export function testNetworkActive() {
  return testNetworkRequested() && testNetworkProblem() === null;
}
function assertTestNetwork() {
  const problem = testNetworkProblem();
  if (problem) throw Error(`Test network misconfigured: ${problem}; transactions are disabled`);
}
/** Genesis hash every RPC must report: the local validator in test mode, otherwise Mainnet. */
export function expectedGenesis() {
  if (!testNetworkRequested()) return MAINNET_GENESIS;
  assertTestNetwork();
  return process.env.NEXT_PUBLIC_HYMET_TEST_GENESIS!;
}
/** Server-side RPC endpoint: the loopback validator in test mode, otherwise MAINNET_RPC_URL. */
export function serverRpcUrl() {
  if (!testNetworkRequested()) return process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
  assertTestNetwork();
  return process.env.HYMET_TEST_RPC_URL!;
}
/** /api/rpc forwards only when the active network's server switch is on. */
export function rpcProxyEnabled() {
  return testNetworkRequested() ? testNetworkActive() : process.env.ENABLE_MAINNET === "true";
}

/**
 * Transactions on the active network. Mainnet requires BOTH switches. Browser bundles only see
 * NEXT_PUBLIC_ENABLE_MAINNET; the server-only ENABLE_MAINNET is enforced by /api/rpc, which refuses every
 * call (including the genesis check and pre-signing simulation) unless it is "true". Server-side callers
 * check both here. In test mode only the correctly configured local validator is enabled; Mainnet is
 * unreachable because every RPC path and genesis check is pinned to it.
 */
export function mainnetTransactionsEnabled() {
  if (testNetworkRequested()) return testNetworkActive();
  if (process.env.NEXT_PUBLIC_ENABLE_MAINNET !== "true") return false;
  return typeof window !== "undefined" || process.env.ENABLE_MAINNET === "true";
}
export function assertMainnetTransactionsEnabled() {
  if (testNetworkRequested()) return assertTestNetwork();
  if (!mainnetTransactionsEnabled())
    throw Error(
      "Mainnet transactions are disabled: NEXT_PUBLIC_ENABLE_MAINNET and ENABLE_MAINNET must both be true",
    );
}
/** Network name shown in the UI: the local test network when requested, otherwise the existing Mainnet wording. */
export function activeNetworkLabel(mainnet = "Solana Mainnet") {
  if (!testNetworkRequested()) return mainnet;
  return process.env.NEXT_PUBLIC_HYMET_TEST_NETWORK === "devnet" ? "Devnet test network (devnet)" : "Local test network (localnet)";
}

/** Human-facing claim target. Local test mode never falls through to Mainnet. */
export function claimNetworkLabel(network: string) {
  if (testNetworkRequested()) {
    const name = process.env.NEXT_PUBLIC_HYMET_TEST_NETWORK === "devnet" ? "Devnet" : "Localnet";
    return testNetworkProblem() ? `${name} unavailable · claims blocked` : name;
  }
  if (network === "mainnet-beta")
    return mainnetTransactionsEnabled()
      ? "Solana Mainnet"
      : "Solana Mainnet · claims launching soon";
  if (network === "devnet") return "Solana Devnet";
  return "Network unavailable · claims blocked";
}
