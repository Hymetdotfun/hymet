import { describe, expect, it } from "vitest";
import {
  cosmicMeteorOpacity,
  shouldRetainCosmicMeteor,
} from "../components/cosmic-canvas";

describe("cosmic meteor fade lifecycle", () => {
  it("fades in smoothly, stays bright during travel, and fades out smoothly", () => {
    expect(cosmicMeteorOpacity(0, 1, 5, 2)).toBe(0);
    expect(cosmicMeteorOpacity(0.5, 1, 5, 2)).toBeCloseTo(0.5, 5);
    expect(cosmicMeteorOpacity(2, 1, 5, 2)).toBe(1);
    expect(cosmicMeteorOpacity(5, 1, 5, 2)).toBe(1);
    expect(cosmicMeteorOpacity(6, 1, 5, 2)).toBeCloseTo(0.5, 5);
    expect(cosmicMeteorOpacity(7, 1, 5, 2)).toBe(0);
    expect(cosmicMeteorOpacity(8, 1, 5, 2)).toBe(0);
  });

  it("retains a meteor until it is both fully faded and outside the canvas", () => {
    expect(shouldRetainCosmicMeteor(0.01, true)).toBe(true);
    expect(shouldRetainCosmicMeteor(0, false)).toBe(true);
    expect(shouldRetainCosmicMeteor(0, true)).toBe(false);
  });
});
