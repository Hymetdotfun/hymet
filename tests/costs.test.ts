import { it, expect } from "vitest";
import { totalCost } from "../lib/costs";
it("adds network, rent, creation and buy amounts with exact integer precision", () =>
  expect(
    totalCost({
      network: 10000n,
      rent: 1234567n,
      poolCreation: 0n,
      initialBuy: 9007199254740993n,
    }),
  ).toBe(9007199255985560n));
it("does not allow invalid negative estimates to lower the balance requirement", () =>
  expect(() =>
    totalCost({ network: 5000n, rent: -1n, poolCreation: 0n, initialBuy: 0n }),
  ).toThrow("Negative"));
