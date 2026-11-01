import { describe, expect, it } from "vitest";
import { centeredCrop } from "../lib/artwork-browser";

describe("centered token artwork crop", () => {
  it("crops landscape imagery from equal top and bottom margins", () => {
    expect(centeredCrop(1600, 900)).toEqual({ x: 350, y: 0, size: 900 });
  });

  it("crops portrait imagery from equal side margins", () => {
    expect(centeredCrop(900, 1600)).toEqual({ x: 0, y: 350, size: 900 });
  });

  it("keeps square imagery intact", () => {
    expect(centeredCrop(720, 720)).toEqual({ x: 0, y: 0, size: 720 });
  });
});
