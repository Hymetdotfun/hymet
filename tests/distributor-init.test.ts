import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import idl from "./fixtures/hymet_rewards_distributor.idl.json";
import production from "../config/production.json";
import { decodeProgramData, initializeDistributorInstruction, setSnapshotAuthorityInstruction, upgradeAuthorityRecordError } from "../lib/distributor-init.mjs";

const program = new PublicKey(production.distributorProgramId);
const owner = new PublicKey(production.upgradeAuthority),
  platform = new PublicKey(production.platformFeeWallet),
  snapshot = new PublicKey(production.snapshotAuthority);

describe("distributor initialize instruction", () => {
  const ix = initializeDistributorInstruction(program, owner, platform, snapshot);
  const spec = idl.instructions.find((i) => i.name === "initialize")!;

  it("matches the built IDL discriminator, accounts and argument", () => {
    expect(idl.address).toBe(production.distributorProgramId);
    expect([...ix.data.subarray(0, 8)]).toEqual(spec.discriminator);
    expect(ix.data.subarray(8)).toEqual(snapshot.toBuffer());
    expect(ix.keys).toHaveLength(spec.accounts.length);
    spec.accounts.forEach((a, i) => {
      const acc = a as { signer?: boolean; writable?: boolean; address?: string };
      expect(ix.keys[i].isSigner).toBe(!!acc.signer);
      expect(ix.keys[i].isWritable).toBe(!!acc.writable);
      if (acc.address) expect(ix.keys[i].pubkey.toBase58()).toBe(acc.address);
    });
    expect(ix.keys[0].pubkey.equals(owner)).toBe(true);
    expect(ix.keys[1].pubkey.equals(platform)).toBe(true);
  });

  it("requires three distinct owner-designated addresses", () => {
    expect(() => initializeDistributorInstruction(program, owner, owner, snapshot)).toThrow("distinct");
    expect(() => initializeDistributorInstruction(program, owner, platform, platform)).toThrow("distinct");
  });

  it("decodes ProgramData upgrade authority and bytes", () => {
    const data = Buffer.alloc(49);
    data.writeUInt32LE(3, 0);
    data[12] = 1;
    owner.toBuffer().copy(data, 13);
    data.set([1, 2, 3, 4], 45);
    const decoded = decodeProgramData(data);
    expect(decoded.upgradeAuthority?.equals(owner)).toBe(true);
    expect([...decoded.bytes]).toEqual([1, 2, 3, 4]);
    data[12] = 0;
    expect(decodeProgramData(data).upgradeAuthority).toBeNull();
    expect(() => decodeProgramData(Buffer.alloc(10))).toThrow();
    expect(() => decodeProgramData(Keypair.generate().publicKey.toBuffer())).toThrow();
  });
});

describe("keeper (snapshot authority) rotation instruction", () => {
  it("matches the built IDL and is signed only by the upgrade authority", () => {
    const next = Keypair.generate().publicKey;
    const ix = setSnapshotAuthorityInstruction(program, owner, next);
    const spec = idl.instructions.find((i) => i.name === "set_snapshot_authority")!;
    expect([...ix.data.subarray(0, 8)]).toEqual(spec.discriminator);
    expect(ix.data.subarray(8)).toEqual(next.toBuffer());
    expect(ix.keys).toHaveLength(spec.accounts.length);
    spec.accounts.forEach((a, i) => {
      const acc = a as { signer?: boolean; writable?: boolean; address?: string };
      expect(ix.keys[i].isSigner).toBe(!!acc.signer);
      expect(ix.keys[i].isWritable).toBe(!!acc.writable);
      if (acc.address) expect(ix.keys[i].pubkey.toBase58()).toBe(acc.address);
    });
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([owner.toBase58()]);
  });
});

describe("post-deploy upgrade authority record", () => {
  const vault = PublicKey.findProgramAddressSync([Buffer.from("squads-vault")], Keypair.generate().publicKey)[0];

  it("records an off-curve Squads vault only once Mainnet ProgramData names it", () => {
    expect(PublicKey.isOnCurve(vault.toBytes())).toBe(false);
    expect(upgradeAuthorityRecordError(production, vault, vault)).toBeNull();
    expect(upgradeAuthorityRecordError(production, owner, vault)).toMatch("on-chain upgrade authority is");
    expect(upgradeAuthorityRecordError(production, null, vault)).toMatch("immutable");
  });

  it("rejects reserved protocol addresses", () => {
    const payer = new PublicKey(production.deployer);
    const legacy = production.legacyPlatformFeeWallets.map((k) => new PublicKey(k));
    for (const key of [platform, ...legacy, payer, new PublicKey(production.deployKey), snapshot, program])
      expect(upgradeAuthorityRecordError(production, key, key)).toMatch("must differ");
  });
});
