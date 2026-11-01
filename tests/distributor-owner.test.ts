import { createHash, createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import production from "../config/production.json";
import { distributorConfigAddress, programDataAddress, reviewedBytesError, setUpgradeAuthorityInstruction, UPGRADEABLE_LOADER } from "../lib/distributor-init.mjs";
import { ownerProofMessage } from "../lib/owner-proof.mjs";
import { verifyOwnerProof } from "../lib/owner-proof-verify.mjs";
import { ownerStatus, prepareOwnerInitialize, type OwnerManifest } from "../lib/distributor-owner";
import { MAINNET_GENESIS } from "../lib/app-network";

const program = new PublicKey(production.distributorProgramId);
const ownerKey = Keypair.generate(), owner = ownerKey.publicKey, deployKey = Keypair.generate().publicKey;
const elf = Buffer.from("reviewed distributor build"), padded = Buffer.concat([elf, Buffer.alloc(8)]);
const manifest: OwnerManifest = {
  ...production,
  upgradeAuthority: owner.toBase58(),
  programSha256: createHash("sha256").update(elf).digest("hex"),
  programBytes: elf.length,
};

function programData(authority: PublicKey | null, bytes = padded) {
  const head = Buffer.alloc(45);
  head.writeUInt32LE(3, 0);
  if (authority) { head[12] = 1; authority.toBuffer().copy(head, 13); }
  return { data: Buffer.concat([head, bytes]), owner: UPGRADEABLE_LOADER, executable: false };
}
function chain({ authority = owner as PublicKey | null, deployed = true, config = false, balance = 10_000_000, bytes = padded } = {}) {
  const accounts = new Map<string, { data: Buffer; owner: PublicKey; executable: boolean } | null>([
    [program.toBase58(), deployed ? { data: Buffer.alloc(36), owner: UPGRADEABLE_LOADER, executable: true } : null],
    [programDataAddress(program).toBase58(), deployed ? programData(authority, bytes) : null],
    [distributorConfigAddress(program).toBase58(), config ? { data: Buffer.alloc(105), owner: program, executable: false } : null],
  ]);
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => accounts.get(k.toBase58()) ?? null),
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    getMinimumBalanceForRentExemption: async () => 1_621_680,
    getBalance: async () => balance,
    getFeeForMessage: async () => ({ value: 5_000 }),
    simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
  } as unknown as Connection;
}

describe("upgrade authority handover instruction", () => {
  it("is loader SetAuthority signed only by the current authority", () => {
    const ix = setUpgradeAuthorityInstruction(program, deployKey, owner);
    expect(ix.programId.equals(UPGRADEABLE_LOADER)).toBe(true);
    expect([...ix.data]).toEqual([4, 0, 0, 0]);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [programDataAddress(program).toBase58(), false, true],
      [deployKey.toBase58(), true, false],
      [owner.toBase58(), false, false],
    ]);
  });

  it("checks deployed bytes against the reviewed hash and zero padding", () => {
    expect(reviewedBytesError(manifest, padded)).toBeNull();
    expect(reviewedBytesError(manifest, Buffer.concat([elf, Buffer.from([1])]))).toMatch("differ");
    expect(reviewedBytesError(manifest, Buffer.from("other build, same size!!!!"))).toMatch("differ");
  });
});

describe("Phantom owner proof", () => {
  const now = 1_800_000_000_000;
  const signed = (key: Keypair, overrides: Record<string, string> = {}) => {
    const proof = { owner: key.publicKey.toBase58(), program: program.toBase58(), issuedAt: new Date(now).toISOString(), nonce: "fdb52d99-8b80-44cc-844c-76b27dc2ef2d", ...overrides };
    const pk = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(key.secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
    return { ...proof, signature: sign(null, Buffer.from(ownerProofMessage(proof)), pk).toString("base64") };
  };

  it("accepts a fresh signature by the owner for this program", () => {
    expect(() => verifyOwnerProof(signed(ownerKey), owner, program, now)).not.toThrow();
  });

  it("rejects another signer, another program, stale proofs and edits", () => {
    const other = Keypair.generate();
    expect(() => verifyOwnerProof(signed(other), owner, program, now)).toThrow("another wallet");
    expect(() => verifyOwnerProof({ ...signed(other), owner: owner.toBase58() }, owner, program, now)).toThrow("signature");
    expect(() => verifyOwnerProof(signed(ownerKey, { program: deployKey.toBase58() }), owner, program, now)).toThrow("another program");
    expect(() => verifyOwnerProof(signed(ownerKey), owner, program, now + 25 * 3_600_000)).toThrow("24 hours");
    expect(() => verifyOwnerProof({ ...signed(ownerKey), nonce: "00000000-0000-0000-0000-000000000000" }, owner, program, now)).toThrow("signature");
  });
});

describe("Phantom owner initialize", () => {
  it("reports the next step at each stage", async () => {
    expect((await ownerStatus(chain({ deployed: false }), manifest)).next).toMatch("CLI");
    expect((await ownerStatus(chain({ authority: deployKey }), manifest)).next).toMatch("hands the upgrade authority");
    expect((await ownerStatus(chain(), manifest)).next).toMatch("Initialize the distributor in Phantom");
    expect((await ownerStatus(chain({ bytes: Buffer.concat([elf, Buffer.from([7])]) }), manifest)).next).toMatch("Stop");
  });

  it("builds an initialize the owner alone signs and pays", async () => {
    const { tx, summary } = await prepareOwnerInitialize(chain(), owner, manifest);
    const message = tx.compileMessage();
    expect(message.header.numRequiredSignatures).toBe(1);
    expect(message.accountKeys[0].equals(owner)).toBe(true);
    expect(tx.feePayer?.equals(owner)).toBe(true);
    const init = tx.instructions[1];
    expect(init.programId.equals(program)).toBe(true);
    expect(init.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(init.keys[0].pubkey.equals(owner)).toBe(true);
    expect(summary).toMatchObject({ platformWallet: production.platformFeeWallet, snapshotAuthority: production.snapshotAuthority, admin: owner.toBase58() });
  });

  it("refuses before handover, after initialization, for another wallet, or without rent", async () => {
    await expect(prepareOwnerInitialize(chain({ authority: deployKey }), owner, manifest)).rejects.toThrow("hand it over first");
    await expect(prepareOwnerInitialize(chain({ config: true }), owner, manifest)).rejects.toThrow("one-time");
    await expect(prepareOwnerInitialize(chain(), deployKey, manifest)).rejects.toThrow("not the HYMET owner");
    await expect(prepareOwnerInitialize(chain({ balance: 1_000 }), owner, manifest)).rejects.toThrow("Owner needs");
    await expect(prepareOwnerInitialize(chain({ deployed: false }), owner, manifest)).rejects.toThrow("not deployed");
  });
});
