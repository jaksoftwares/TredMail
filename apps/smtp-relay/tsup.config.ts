import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
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
