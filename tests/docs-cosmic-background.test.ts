import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDocsMeteor, docsMeteorStopRatio } from "../components/docs-cosmic-background";

const sequence = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

describe("docs introduction sky", () => {
  it.each([[1200, 560], [900, 430], [375, 470], [320, 520]])("meteors fall down-left and stop before the copy at %i×%i", (width, height) => {
    const random = sequence(width + height);
    for (let index = 0; index < 500; index++) {
      const meteor = createDocsMeteor(width, height, random);
      expect(meteor.vx).toBeLessThan(0);
      expect(meteor.vy).toBeGreaterThan(0);
      expect(meteor.life).toBeGreaterThan(0.25);
      expect(meteor.x + meteor.vx * meteor.life).toBeGreaterThanOrEqual(width * docsMeteorStopRatio(width) - 0.01);
      expect(meteor.fadeIn + meteor.fadeOut).toBeLessThan(meteor.life);
      expect(meteor.brightness).toBeLessThanOrEqual(1);
    }
  });

  it("appears only in the introduction hero, without the old planet or the button arrow", () => {
    const hub = readFileSync("components/docs-hub.tsx", "utf8");
    expect(hub.match(/<DocsCosmicBackground \/>/g)).toHaveLength(1);
    expect(hub.indexOf("<DocsCosmicBackground />")).toBeGreaterThan(hub.indexOf("function Introduction"));
    expect(hub.indexOf("<DocsCosmicBackground />")).toBeLessThan(hub.indexOf("function SectionContent"));
    expect(hub).not.toContain("PlanetArt");
    expect(hub).toContain('href="/launch">Create a Token</Link>');
    expect(readFileSync("app/globals.css", "utf8")).not.toContain("dh-planet");
  });
});
