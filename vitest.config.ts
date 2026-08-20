import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The cadence + time tests deliberately pin a non-UTC zone so a UTC CI box
    // reproduces what Eddie sees in Los Angeles.
    env: {
      TZ: "UTC",
    },
  },
});
