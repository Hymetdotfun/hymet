import { Connection, PublicKey } from "@solana/web3.js";
import { expectedGenesis, serverRpcUrl } from "./app-network";
import { verifyConfiguredDistributorAuthorities, verifyDistributorDeployment } from "./distributor-engine";
import { distributorAllowed } from "./launch-mode";
import { configuredPlatformFeeRecipient } from "./transactions";

const PLACEHOLDER_PROGRAM = "CWDBD8de82UWLL3xZBd117t3uPoe25ZKy5TcHLLTg9xY";

/** Only a positive result is reused, briefly; the owner flags are still checked on every call and failures retry at once. */
const VERIFIED_TTL_MS = 60_000;
let verified: { key: string; at: number; result: { program: PublicKey; connection: Connection; config: PublicKey } } | null = null;

/**
 * The configured distributor, only when the owner flags are set AND the active network (genesis-checked) shows it
 * executable, initialized with the configured HYMET recipient, and held by the configured snapshot/upgrade authorities.
 */
export async function verifiedDistributor() {
  const configured = process.env.HYMET_DISTRIBUTOR_PROGRAM_ID;
  if (
    !distributorAllowed() ||
    !configured ||
    configured === PLACEHOLDER_PROGRAM ||
    process.env.HYMET_DISTRIBUTOR_VERIFIED !== "true" ||
    process.env.HYMET_DISTRIBUTOR_APP_VERIFIED !== "true"
  )
    return null;
  try {
    const key = `${serverRpcUrl()}|${configured}|${process.env.HYMET_PLATFORM_FEE_RECIPIENT}|${process.env.HYMET_SNAPSHOT_AUTHORITY}|${process.env.HYMET_UPGRADE_AUTHORITY}`;
    if (verified?.key === key && Date.now() - verified.at < VERIFIED_TTL_MS) return verified.result;
    const program = new PublicKey(configured);
    const connection = new Connection(serverRpcUrl(), "confirmed");
    if ((await connection.getGenesisHash()) !== expectedGenesis()) return null;
    const account = await connection.getAccountInfo(program, "confirmed");
    const config = await verifyDistributorDeployment(connection, program, configuredPlatformFeeRecipient());
    await verifyConfiguredDistributorAuthorities(connection, program);
    if (!account?.executable) return null;
    const result = { program, connection, config };
    verified = { key, at: Date.now(), result };
    return result;
  } catch {
    return null;
  }
}
