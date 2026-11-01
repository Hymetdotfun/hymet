export function totalCost(parts: {
  network: bigint;
  rent: bigint;
  poolCreation: bigint;
  initialBuy: bigint;
}) {
  const values = Object.values(parts);
  if (values.some((v) => v < 0n)) throw Error("Negative cost estimate");
  return values.reduce((sum, v) => sum + v, 0n);
}
