import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { metadata } from "../app/layout";

const pngSize = (path: string) => {
  const file = readFileSync(path);
  expect(file.subarray(1, 4).toString()).toBe("PNG");
  return [file.readUInt32BE(16), file.readUInt32BE(20)];
};

describe("favicons", () => {
  it("every PNG listed in the metadata exists at its declared size", () => {
    const listed = [...metadata.icons.icon, ...metadata.icons.apple].filter((icon) => icon.type === "image/png");
    expect(listed.map((icon) => icon.sizes).sort()).toEqual(["16x16", "180x180", "180x180", "192x192", "32x32", "512x512"].sort());
    for (const icon of listed) {
      const [width] = icon.sizes.split("x").map(Number);
      expect(pngSize(`public${icon.url}`)).toEqual([width, width]);
    }
  });

  it("favicon.ico holds the 16, 32 and 48 pixel images", () => {
    const ico = readFileSync("public/favicon.ico");
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(Array.from({ length: count }, (_, i) => ico[6 + i * 16])).toEqual([16, 32, 48]);
    for (let i = 0; i < count; i += 1) {
      const entry = 6 + i * 16;
      const start = ico.readUInt32LE(entry + 12);
      expect(start + ico.readUInt32LE(entry + 8)).toBeLessThanOrEqual(ico.length);
      expect(ico.subarray(start + 1, start + 4).toString()).toBe("PNG");
    }
  });

  it("the touch icon has no transparency, and no file convention icon competes with the metadata", () => {
    expect(readFileSync("public/apple-touch-icon.png")[25]).toBe(2);
    for (const name of ["favicon.ico", "icon.png", "icon.svg", "apple-icon.png"]) expect(existsSync(`app/${name}`)).toBe(false);
  });
});
