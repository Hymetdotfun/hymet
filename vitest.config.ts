import { defineConfig } from "vitest/config";

// Test this checkout only; extracted deliverables in outputs/ are separate copies.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"] },
});
