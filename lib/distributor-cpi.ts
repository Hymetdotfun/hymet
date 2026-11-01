import { createHash } from "node:crypto";

export function anchorInstructionData(name: string, args: bigint[] = []) {
  const discriminator = createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
  const bytes = Buffer.alloc(8 + args.length * 8);
  discriminator.copy(bytes, 0);
  args.forEach((value, index) => {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error("CPI argument exceeds u64");
    bytes.writeBigUInt64LE(value, 8 + index * 8);
  });
  return bytes;
}

export const dbcPartnerClaimData = () => anchorInstructionData("claim_trading_fee", [0xffff_ffff_ffff_ffffn, 0xffff_ffff_ffff_ffffn]);
export const dammPositionFeeClaimData = () => anchorInstructionData("claim_position_fee");
