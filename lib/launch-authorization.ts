/** Name and ticker exactly as the launch authorization signs them. */
export const authorizedName = (value: string) => value.trim().normalize("NFKC").replace(/\s+/gu, " ");
export const authorizedTicker = (value: string) => value.normalize("NFKC").trim().toUpperCase();

export const LAUNCH_AUTHORIZATION_MAX_AGE_MS = 5 * 60_000;

/**
 * The one message a creator signs to start a launch. It authorizes the launch record and the metadata upload, and binds
 * both to this origin, wallet, name and ticker. Names are not unique: a token is identified by its mint address.
 */
export function launchAuthorizationMessage(a: { origin: string; wallet: string; name: string; ticker: string; nonce: string; issuedAt: string }) {
  return `HYMET launch authorization\nOrigin: ${a.origin}\nWallet: ${a.wallet}\nName: ${authorizedName(a.name)}\nTicker: ${authorizedTicker(a.ticker)}\nNonce: ${a.nonce}\nIssuedAt: ${a.issuedAt}`;
}

/** Whether a signed timestamp and nonce are well formed and recent. */
export function launchAuthorizationFresh(issuedAt: string, nonce: string, now = Date.now()) {
  const issued = Date.parse(issuedAt);
  return Number.isFinite(issued) && Math.abs(now - issued) <= LAUNCH_AUTHORIZATION_MAX_AGE_MS && /^[0-9a-f-]{36}$/i.test(nonce);
}
