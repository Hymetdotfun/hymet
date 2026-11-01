import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { programUpgradeAuthority, verifyDistributorAuthorities } from "../lib/distributor-engine";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const program = Keypair.generate().publicKey;
const programData = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];

function programDataAccount(authority: PublicKey | null) {
  const data = Buffer.alloc(45 + 16);
  data.writeUInt32LE(3, 0);
  if (authority) {
    data[12] = 1;
    authority.toBuffer().copy(data, 13);
  }
  return { data };
}
function configAccount(admin: PublicKey, platform: PublicKey, snapshot: PublicKey) {
  const data = Buffer.alloc(105);
  admin.toBuffer().copy(data, 8);
  platform.toBuffer().copy(data, 40);
  snapshot.toBuffer().copy(data, 72);
  return { data };
}
function connection(accounts: Map<string, { data: Buffer }>) {
  return {
    getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null,
  } as unknown as Connection;
}

describe("distributor authority verification", () => {
  const deployer = Keypair.generate().publicKey,
    platform = Keypair.generate().publicKey,
    snapshot = Keypair.generate().publicKey;

  it("reads the upgrade authority from ProgramData", async () => {
    expect((await programUpgradeAuthority(connection(new Map([[programData.toBase58(), programDataAccount(deployer)]])), program))?.equals(deployer)).toBe(true);
    expect(await programUpgradeAuthority(connection(new Map([[programData.toBase58(), programDataAccount(null)]])), program)).toBeNull();
    await expect(programUpgradeAuthority(connection(new Map()), program)).rejects.toThrow("ProgramData");
  });

  it("accepts only the configured snapshot and upgrade authorities", async () => {
    const accounts = new Map([
      [programData.toBase58(), programDataAccount(deployer)],
      [config.toBase58(), configAccount(deployer, platform, snapshot)],
    ]);
    await expect(verifyDistributorAuthorities(connection(accounts), program, snapshot, deployer)).resolves.toBeUndefined();
    await expect(verifyDistributorAuthorities(connection(accounts), program, Keypair.generate().publicKey, deployer)).rejects.toThrow("snapshot authority");
    await expect(verifyDistributorAuthorities(connection(accounts), program, snapshot, Keypair.generate().publicKey)).rejects.toThrow("upgrade authority");
  });

  it("allows an immutable (finalized) program", async () => {
    const accounts = new Map([
      [programData.toBase58(), programDataAccount(null)],
      [config.toBase58(), configAccount(deployer, platform, snapshot)],
    ]);
    await expect(verifyDistributorAuthorities(connection(accounts), program, snapshot, deployer)).resolves.toBeUndefined();
  });
});
