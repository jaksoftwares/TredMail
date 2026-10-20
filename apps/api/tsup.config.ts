import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/cli/seed.ts", "src/cli/revoke-api-key.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source, so bundle them; every npm package stays
  // external (Prisma in particular cannot be bundled) and resolves from node_modules.
  noExternal: [/^@tredmail\//],
  external: [/^(?![./]|@tredmail\/)/],
});
