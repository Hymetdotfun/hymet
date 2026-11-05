// Generates every favicon from the official logo, public/hymet-logo.svg, on the site background. Run after changing the logo:
//   node scripts/generate-favicons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const BACKGROUND = "#101211"; // --bg in app/globals.css
const logo = readFileSync("public/hymet-logo.svg", "utf8").match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1];
// The mark's visual centre is (51.5, 52); enlarge it slightly so it stays legible at 16px.
const art = (radius) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="${radius}" fill="${BACKGROUND}"/><g transform="translate(50 50) scale(1.12) translate(-51.5 -52)">${logo}</g></svg>`;
const png = (size, radius) => {
  const image = sharp(Buffer.from(art(radius)), { density: 72 * Math.max(1, Math.ceil(size / 100)) * 4 }).resize(size, size);
  return (radius === 0 ? image.removeAlpha() : image).png({ compressionLevel: 9 }).toBuffer();
};

// An .ico holding PNG images, which every current browser reads.
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + i * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

const ROUNDED = 22;
for (const size of [16, 32, 192, 512]) writeFileSync(`public/favicon-${size}x${size}.png`, await png(size, ROUNDED));
// iOS rounds the corners itself and turns transparency black, so the 180px icons are square and opaque.
const touch = await png(180, 0);
writeFileSync("public/favicon-180x180.png", touch);
writeFileSync("public/apple-touch-icon.png", touch);
writeFileSync("public/favicon.ico", ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(size, ROUNDED) })))));
