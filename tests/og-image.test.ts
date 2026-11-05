import { readFileSync, statSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { metadata } from "../app/layout";

const IMAGE = "public/og-image.jpg";

describe("social sharing preview", () => {
  it("is a 1200x630 JPEG small enough for every major platform", async () => {
    const image = await sharp(IMAGE).metadata();
    expect([image.format, image.width, image.height, image.space]).toEqual(["jpeg", 1200, 630, "srgb"]);
    expect(statSync(IMAGE).size).toBeLessThan(300 * 1024);
  });

  it("declares the same image and copy to Open Graph and Twitter, resolved against the public origin", () => {
    const [open] = metadata.openGraph.images, [card] = metadata.twitter.images;
    expect(metadata.metadataBase.href).toBe("https://hymet.fun/");
    expect(new URL(open.url, metadata.metadataBase).href).toBe("https://hymet.fun/og-image.jpg");
    expect(metadata.twitter.card).toBe("summary_large_image");
    expect(card).toEqual(open);
    expect([open.width, open.height, open.type]).toEqual([1200, 630, "image/jpeg"]);
    expect(metadata.twitter.title).toBe(metadata.openGraph.title);
    expect(metadata.twitter.description).toBe(metadata.openGraph.description);
    readFileSync(`public${open.url}`);
  });

  it("makes no claim that launches or trading are open", () => {
    const copy = `${metadata.openGraph.title} ${metadata.openGraph.description}`.toLowerCase();
    for (const claim of ["now live", "live now", "trade now", "launch now", "guaranteed", "earn"]) expect(copy).not.toContain(claim);
  });
});
