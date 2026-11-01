export type PlatformFeeAction = "inspect" | "prepare-dbc" | "prepare-damm";

export type PlatformFeeAuthorization = {
  wallet: string;
  action: PlatformFeeAction;
  pool?: string;
  position?: string;
  issuedAt: string;
  nonce: string;
};

/** The exact short-lived message signed by the platform wallet for the fee API. */
export function platformFeeAuthorizationMessage(
  authorization: PlatformFeeAuthorization,
  origin: string,
) {
  return [
    "HYMET platform fee authorization v1",
    `Origin: ${origin}`,
    `Wallet: ${authorization.wallet}`,
    `Action: ${authorization.action}`,
    `Pool: ${authorization.pool ?? ""}`,
    `Position: ${authorization.position ?? ""}`,
    `IssuedAt: ${authorization.issuedAt}`,
    `Nonce: ${authorization.nonce}`,
  ].join("\n");
}
