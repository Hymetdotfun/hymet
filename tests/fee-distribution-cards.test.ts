import { describe, expect, it } from "vitest";
import { feeDistributionCards } from "../components/fee-distribution";

const values = (cards: ReturnType<typeof feeDistributionCards>) => cards?.map((card) => card.value);

describe("token fee distribution cards", () => {
  it("derives creator and holder shares from the stored split", () => {
    expect(values(feeDistributionCards(100, 5000, 5000))).toEqual(["1%", "20%", "40%", "40%"]);
    expect(values(feeDistributionCards(100, 0, 10_000))).toEqual(["1%", "20%", "0%", "80%"]);
    expect(values(feeDistributionCards(100, 500, 9500))).toEqual(["1%", "20%", "4%", "76%"]);
    expect(values(feeDistributionCards(250, 10_000, 0))).toEqual(["2.5%", "20%", "80%", "0%"]);
  });

  it("explains each share relative to the fees remaining after HYMET", () => {
    expect(feeDistributionCards(100, 5000, 5000)?.[2].detail).toBe("50% of the remaining 80%");
  });

  it("shows nothing rather than a guess for an invalid stored split", () => {
    expect(feeDistributionCards(100, 6000, 6000)).toBeNull();
  });
});
