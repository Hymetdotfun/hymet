import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { LAUNCH_PRIORITY_MICROLAMPORTS, WALLET_PRIORITY_MICROLAMPORTS } from "../lib/transactions";

// Every transaction a wallet signs in the app sets a non-zero price, so Phantom has no reason to change the reviewed message.
const WALLET_SIGNED = ["lib/dbc-swap.ts", "lib/damm-swap.ts", "lib/creator-fees.ts", "lib/damm-fees.ts", "lib/platform-fees.ts", "app/api/fees/transaction/route.ts"];

it("uses the same explicit non-zero price as launches", () => {
  expect(WALLET_PRIORITY_MICROLAMPORTS).toBe(LAUNCH_PRIORITY_MICROLAMPORTS);
  expect(WALLET_PRIORITY_MICROLAMPORTS).toBeGreaterThan(0);
});

it.each(WALLET_SIGNED)("%s sets the shared price and never a zero price", (file) => {
  const source = readFileSync(file, "utf8");
  expect(source).toMatch(/setComputeUnitPrice\(\{\s*microLamports:\s*WALLET_PRIORITY_MICROLAMPORTS\s*\}\)/);
  expect(source).not.toMatch(/microLamports:\s*0\b/);
});
