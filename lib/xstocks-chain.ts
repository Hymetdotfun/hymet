import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  getExtensionTypes,
  ExtensionType,
  getTransferFeeConfig,
  getPausableConfig,
  getScaledUiAmountConfig,
  getDefaultAccountState,
  getTransferHook,
  getPermanentDelegate,
  AccountState,
} from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DAMM_V2_PROGRAM_ID,
  deriveTokenBadgeAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { type OfficialXstock, type Xstock } from "./xstocks";
import { MAINNET_GENESIS } from "./app-network";

export function inspectXstock(
  a: OfficialXstock,
  info: AccountInfo<Buffer> | null,
  badge: boolean,
): Xstock {
  const unavailable = (reason: string): Xstock => ({
    ...a,
    status: "Verification Unavailable",
    reasons: [reason],
  });
  try {
    if (
      !info ||
      info.executable ||
      ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((p) =>
        p.equals(info.owner),
      )
    )
      return unavailable("Mint missing or invalid token program");
    const mint = unpackMint(new PublicKey(a.mint), info, info.owner);
    if (!mint.isInitialized) return unavailable("Mint is not initialized");
    const types = getExtensionTypes(mint.tlvData);
    const restrictions: string[] = [];
    if (mint.freezeAuthority)
      restrictions.push("Issuer can freeze token accounts");
    if (mint.mintAuthority) restrictions.push("Issuer retains mint authority");
    const delegate = getPermanentDelegate(mint);
    if (delegate)
      restrictions.push(
        `Permanent delegate can transfer/burn balances: ${delegate.delegate.toBase58()}`,
      );
    const hook = getTransferHook(mint);
    if (hook)
      restrictions.push(
        hook.programId.equals(PublicKey.default)
          ? `Transfer-hook extension currently disabled; update authority ${hook.authority.toBase58()}`
          : `Transfer-hook program ${hook.programId.toBase58()}: extra accounts and execution are not verified`,
      );
    const defaultState = getDefaultAccountState(mint);
    if (defaultState)
      restrictions.push(
        `Default account state: ${AccountState[defaultState.state] ?? "unknown"}`,
      );
    const pause = getPausableConfig(mint);
    if (pause)
      restrictions.push(
        pause.paused
          ? "Transfers currently paused"
          : "Issuer can pause transfers",
      );
    if (getScaledUiAmountConfig(mint))
      restrictions.push(
        "Scaled UI amount: raw balances may differ from issuer display amounts",
      );
    const fee = getTransferFeeConfig(mint);
    const feeRestricted =
      !!fee &&
      (!fee.transferFeeConfigAuthority.equals(PublicKey.default) ||
        fee.olderTransferFee.transferFeeBasisPoints !== 0 ||
        fee.newerTransferFee.transferFeeBasisPoints !== 0 ||
        fee.olderTransferFee.maximumFee !== 0n ||
        fee.newerTransferFee.maximumFee !== 0n);
    if (fee)
      restrictions.push(
        feeRestricted
          ? "Transfer fees/config authority require a separate verified path"
          : "Zero immutable transfer fee",
      );
    const permissionless =
      types.every((t) =>
        [
          ExtensionType.MetadataPointer,
          ExtensionType.TokenMetadata,
          ExtensionType.TransferFeeConfig,
        ].includes(t),
      ) && !feeRestricted;
    const reasons: string[] = [];
    let status: Xstock["status"] = "Unsupported by Migration";
    if (!a.active) {
      status = "Verification Unavailable";
      reasons.push(
        "Official issuance inactive or trading halted; launch availability cannot be verified",
      );
    }
    if (
      a.active &&
      ((!permissionless && !badge) ||
        feeRestricted ||
        pause?.paused ||
        types.includes(ExtensionType.NonTransferable) ||
        (defaultState !== null &&
          defaultState.state !== AccountState.Initialized))
    ) {
      status = "Unsupported by DBC";
      reasons.push(
        !permissionless && !badge
          ? "DBC requires an initialized protocol token badge for these extensions; none verified"
          : "Transfer restrictions are not supported by this launcher",
      );
    }
    reasons.push(
      "Read-only: the complete xStocks quote launch, migration and creator-fee claim path is not verified in this launcher; Token-2022 claims remain blocked",
    );
    return {
      ...a,
      status,
      reasons,
      decimals: mint.decimals,
      program: info.owner.toBase58(),
      extensions: types.map(
        (t) => ExtensionType[t] || `Unknown extension ${t}`,
      ),
      badge,
      restrictions,
    };
  } catch {
    return unavailable(
      "Mint extensions/layout could not be independently decoded",
    );
  }
}

export async function verifyXstocks(
  c: Connection,
  assets: OfficialXstock[],
): Promise<Xstock[]> {
  if ((await c.getGenesisHash()) !== MAINNET_GENESIS)
    throw Error("Mainnet verification failed");
  const programs = await c.getMultipleAccountsInfo(
    [DYNAMIC_BONDING_CURVE_PROGRAM_ID, DAMM_V2_PROGRAM_ID],
    "confirmed",
  );
  if (programs.length !== 2 || !programs.every((p) => p?.executable))
    throw Error("Meteora programs unavailable");
  const sdk = new DynamicBondingCurveClient(c, "confirmed");
  const result: Xstock[] = [];
  for (let i = 0; i < assets.length; i += 40) {
    const batch = assets.slice(i, i + 40),
      mints = batch.map((a) => new PublicKey(a.mint));
    try {
      const infos = await c.getMultipleAccountsInfo(
        [...mints, ...mints.map(deriveTokenBadgeAddress)],
        "confirmed",
      );
      if (infos.length !== batch.length * 2)
        throw Error("Incomplete mint/badge snapshot");
      batch.forEach((a, j) => {
        const b = infos[j + batch.length];
        let badge = false;
        if (
          b?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) &&
          !b.executable
        ) {
          try {
            badge = sdk.program.coder.accounts
              .decode<{ tokenMint: PublicKey }>("tokenBadge", b.data)
              .tokenMint.equals(mints[j]);
          } catch {
            /* Wrong badge data cannot authorize a mint. */
          }
        }
        result.push(inspectXstock(a, infos[j], badge));
      });
    } catch {
      result.push(
        ...batch.map((a) => ({
          ...a,
          status: "Verification Unavailable" as const,
          reasons: ["Mainnet RPC mint/badge verification unavailable"],
        })),
      );
    }
  }
  return result;
}
