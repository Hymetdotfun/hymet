import { Connection, PublicKey } from "@solana/web3.js";
import { expectedGenesis, serverRpcUrl } from "./app-network";
import { verifyConfiguredDistributorAuthorities, verifyDistributorDeployment } from "./distributor-engine";
import { distributorAllowed } from "./launch-mode";
import { configuredPlatformFeeRecipient } from "./transactions";

const PLACEHOLDER_PROGRAM = "CWDBD8de82UWLL3xZBd117t3uPoe25ZKy5TcHLLTg9xY";

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
    const program = new PublicKey(configured);
    const connection = new Connection(serverRpcUrl(), "confirmed");
    if ((await connection.getGenesisHash()) !== expectedGenesis()) return null;
    const account = await connection.getAccountInfo(program, "confirmed");
    const config = await verifyDistributorDeployment(connection, program, configuredPlatformFeeRecipient());
    await verifyConfiguredDistributorAuthorities(connection, program);
    return account?.executable ? { program, connection, config } : null;
  } catch {
    return null;
  }
}
