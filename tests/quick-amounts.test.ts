import { describe, expect, it } from "vitest";
import { formatUnits, quickAmount } from "../lib/dbc-swap";
import { units } from "../lib/config";

describe("trade panel quick amounts", () => {
  it("formats raw units exactly, without float rounding", () => {
    expect(formatUnits(128291171n, 9)).toBe("0.128291171");
    expect(formatUnits(3103427148570335n, 9)).toBe("3103427.148570335");
    expect(formatUnits(1_000_000_000n, 9)).toBe("1");
    expect(formatUnits(0n, 9)).toBe("0");
  });

  it("rounds percentages down and MAX is the exact balance, so the input never exceeds the wallet", () => {
    const balance = 128291171n;
    expect(quickAmount(balance, 9, 25)).toBe("0.032072792");
    expect(quickAmount(balance, 9, 50)).toBe("0.064145585");
    expect(quickAmount(balance, 9, 75)).toBe("0.096218378");
    expect(quickAmount(balance, 9, 100)).toBe("0.128291171");
    for (const p of [25, 50, 75, 100] as const) expect(units(quickAmount(balance, 9, p), 9) <= balance).toBe(true);
    expect(quickAmount(3n, 9, 25)).toBe("0");
  });

  it("returns nothing for an empty balance", () => {
    expect(quickAmount(0n, 9, 100)).toBe("");
  });
});
