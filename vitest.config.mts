import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    environment: "node",
  },
});
