// Renders the 1200x630 social sharing image, public/og-image.jpg, from the official logo and the site palette. Run after
// changing the logo or copy:
//   node scripts/generate-og-image.mjs
// The sky is seeded, so the output is original and repeatable.
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const W = 1200, H = 630, SS = 2, RW = W * SS, RH = H * SS;
const OUTPUT = process.argv[2] || "public/og-image.jpg";

// Site palette (app/globals.css, public/hymet-logo.svg).
const PALETTE = { bg: "#050807", teal: "#46e5c3", em: "#36DDB9", mint: "#a1ffec", logo: "#8FF5DB", ink: "#f1f6f3", muted: "#a8b7b0" };
const linear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255));
const BG = rgb(PALETTE.bg), TEAL = rgb(PALETTE.teal), MINT = rgb(PALETTE.mint);

const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

const color = new Float32Array(RW * RH * 3);
const add = (i, r, g, b) => { color[i * 3] += r; color[i * 3 + 1] += g; color[i * 3 + 2] += b; };

// Quiet the stars behind the copy so the text stays the focal point.
const textQuiet = (x, y) => {
  const dx = (x / SS - 600) / 390, dy = (y / SS - 300) / 215;
  return 0.16 + 0.84 * smooth(0.72, 1.28, Math.hypot(dx, dy));
};

// 1. Sky: layered teal atmosphere, sparse stars and a dark world on the horizon.
const stars = seeded(902);
const WORLD = { x: 600 * SS, y: 1640 * SS, r: 1096 * SS };
const pool = (nx, ny, cx, cy, sx, sy) => Math.exp(-(((nx - cx) / sx) ** 2 + ((ny - cy) / sy) ** 2));
for (let y = 0; y < RH; y++) {
  for (let x = 0; x < RW; x++) {
    const i = y * RW + x, nx = x / RW, ny = y / RH;
    // A wide, soft light from the lower right, a faint counterweight at the upper left and a low glow behind the copy.
    const atmosphere =
      0.016 * pool(nx, ny, 0.93, 0.74, 0.46, 0.66) +
      0.005 * pool(nx, ny, 1.02, 0.08, 0.38, 0.42) +
      0.005 * pool(nx, ny, 0.02, 0.14, 0.36, 0.48) +
      0.004 * pool(nx, ny, 0.5, 0.5, 0.34, 0.3);
    let r = BG[0] + TEAL[0] * atmosphere, g = BG[1] + TEAL[1] * atmosphere, b = BG[2] + TEAL[2] * atmosphere;

    // Dark world and its thin lit atmosphere.
    const edge = Math.hypot(x - WORLD.x, y - WORLD.y) - WORLD.r;
    if (edge < 0) {
      const inner = Math.exp(edge / (34 * SS));
      r = BG[0] * 0.55 + TEAL[0] * inner * 0.1; g = BG[1] * 0.55 + TEAL[1] * inner * 0.1; b = BG[2] * 0.55 + TEAL[2] * inner * 0.1;
    } else {
      const light = 0.48 + 0.52 * smooth(0.5, 0.95, nx);
      const haze = (Math.exp(-edge / (5 * SS)) * 0.5 + Math.exp(-edge / (52 * SS)) * 0.075) * light;
      r += TEAL[0] * haze; g += TEAL[1] * haze; b += TEAL[2] * haze;
    }
    color[i * 3] = r; color[i * 3 + 1] = g; color[i * 3 + 2] = b;
  }
}
for (let n = 0; n < 300; n++) {
  const sx = stars() * RW, sy = stars() * RH;
  if (Math.hypot(sx - WORLD.x, sy - WORLD.y) < WORLD.r + 14 * SS) continue;
  const large = stars() < 0.06, radius = (large ? 1.2 : 0.68) * SS * (0.55 + stars() * 0.45);
  const power = (large ? 0.72 : 0.2 + stars() * 0.3) * textQuiet(sx, sy);
  const tint = stars() < 0.3 ? MINT : [0.9, 1, 0.97];
  const reach = Math.ceil(radius * 3);
  for (let y = Math.max(0, Math.floor(sy - reach)); y <= Math.min(RH - 1, sy + reach); y++) {
    for (let x = Math.max(0, Math.floor(sx - reach)); x <= Math.min(RW - 1, sx + reach); x++) {
      const v = power * Math.exp(-(((x - sx) ** 2 + (y - sy) ** 2) / (radius * radius)));
      add(y * RW + x, tint[0] * v, tint[1] * v, tint[2] * v);
    }
  }
}

// 2. Develop: downsample, bloom, filmic tone curve, vignette and dithering so the dark gradients do not band.
const hdr = new Float32Array(W * H * 3);
for (let y = 0; y < RH; y++) {
  for (let x = 0; x < RW; x++) {
    const from = (y * RW + x) * 3, to = (Math.floor(y / SS) * W + Math.floor(x / SS)) * 3;
    for (let k = 0; k < 3; k++) hdr[to + k] += color[from + k] / (SS * SS);
  }
}
function blur(source, width, height, radius) {
  let input = source;
  for (let pass = 0; pass < 3; pass++) {
    const out = new Float32Array(input.length);
    for (let axis = 0; axis < 2; axis++) {
      const src = axis === 0 ? input : out.slice();
      const major = axis === 0 ? height : width, minor = axis === 0 ? width : height;
      const size = radius * 2 + 1;
      for (let a = 0; a < major; a++) {
        for (let k = 0; k < 3; k++) {
          const at = (b) => { const c = clamp(b, 0, minor - 1); return (axis === 0 ? a * width + c : c * width + a) * 3 + k; };
          let sum = 0;
          for (let b = -radius; b <= radius; b++) sum += src[at(b)];
          for (let b = 0; b < minor; b++) {
            out[at(b)] = sum / size;
            sum += src[at(b + radius + 1)] - src[at(b - radius)];
          }
        }
      }
    }
    input = out;
  }
  return input;
}
const bright = new Float32Array(W * H * 3);
for (let i = 0; i < W * H * 3; i++) bright[i] = Math.max(0, hdr[i] - 0.34);
const bloomNear = blur(bright, W, H, 5), bloomFar = blur(bright, W, H, 24);
const pixels = Buffer.alloc(W * H * 3);
const aces = (x) => clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
const toSrgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const dither = seeded(31);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const vignette = 1 - 0.38 * smooth(0.48, 1.05, Math.hypot((x / W - 0.5) * 1.15, (y / H - 0.5) * 1.05) * 1.5);
    const grain = (dither() + dither() - 1) * 0.65;
    for (let k = 0; k < 3; k++) {
      const value = (hdr[i + k] + bloomNear[i + k] * 0.42 + bloomFar[i + k] * 0.38) * vignette * 1.08;
      pixels[i + k] = clamp(Math.round(toSrgb(aces(value)) * 255 + grain), 0, 255);
    }
  }
}

// 3. The official logo and the copy. The site declares this font stack; the mark comes straight from public/hymet-logo.svg.
const logo = readFileSync("public/hymet-logo.svg", "utf8").match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1];
const FONT = `Inter, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif`;
const copy = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
  <defs>
    <filter id="halo" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="16"/></filter>
    <filter id="logoGlow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>
  <g filter="url(#halo)" fill="${PALETTE.bg}" opacity=".7" text-anchor="middle" font-weight="600">
    <text x="600" y="268" font-size="80" letter-spacing="-3.4">The HYPE-Only</text>
    <text x="600" y="352" font-size="80" letter-spacing="-3.4">Launchpad</text>
    <text x="600" y="420" font-size="29">Create. Launch. Discover. Paired with HYPE.</text>
  </g>
  <g transform="translate(493 72) scale(.74)" opacity=".55" filter="url(#logoGlow)">${logo}</g>
  <g transform="translate(493 72) scale(.74)">${logo}</g>
  <text x="571" y="123" font-size="36" font-weight="600" letter-spacing="1.4" fill="${PALETTE.ink}" dominant-baseline="auto" text-anchor="start">HYMET</text>
  <g text-anchor="middle">
    <text x="600" y="268" font-size="80" font-weight="600" letter-spacing="-3.4" fill="${PALETTE.ink}">The <tspan fill="${PALETTE.em}">HYPE</tspan>-Only</text>
    <text x="600" y="352" font-size="80" font-weight="600" letter-spacing="-3.4" fill="${PALETTE.ink}">Launchpad</text>
    <text x="600" y="420" font-size="29" font-weight="400" fill="#d5dfda">Create. Launch. Discover. Paired with HYPE.</text>
    <text x="600" y="578" font-size="23" font-weight="500" letter-spacing=".9" fill="${PALETTE.muted}">hymet.fun</text>
  </g>
</svg>`;
const output = await sharp(pixels, { raw: { width: W, height: H, channels: 3 } })
  .composite([{ input: Buffer.from(copy) }])
  .jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: true })
  .toBuffer();
writeFileSync(OUTPUT, output);
console.log(`${OUTPUT}: ${W}x${H}, ${Math.round(output.length / 1024)} KB`);
