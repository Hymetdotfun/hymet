import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
const config = (phase: string): NextConfig => ({
  reactStrictMode: true,
  poweredByHeader: false,
  // A wallet-signing site must not be framed by another site (clickjacking).
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      ],
    }];
  },
  typescript: { tsconfigPath: phase === PHASE_DEVELOPMENT_SERVER && /^work\/tsconfig\.preview-\d+\.json$/.test(process.env.HYMET_PREVIEW_TSCONFIG || '') ? process.env.HYMET_PREVIEW_TSCONFIG : 'tsconfig.json' },
  // Isolate production output from stale `.next` artifacts left by interrupted
  // builds. The dedicated path also avoids build/dev output collisions on Windows.
  // Vercel's Next.js adapter requires the framework's conventional `.next` output.
  distDir: process.env.VERCEL === "1" && process.platform !== "win32"
    ? ".next"
    : phase === PHASE_DEVELOPMENT_SERVER
      ? (/^next-preview-\d+$/.test(process.env.HYMET_PREVIEW_DIR || '') ? process.env.HYMET_PREVIEW_DIR : "next-dev")
      : "next-build",
  outputFileTracingRoot: process.cwd(),
  experimental: { cpus: 1 },
});
export default config;
