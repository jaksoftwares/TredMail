/**
 * Writes the OpenAPI spec to apps/console/src/generated/openapi.json for the console's API
 * reference (the console is a separate npm project and cannot import @tredmail/core).
 *
 *   npm run openapi:export
 *
 * apps/api/tests/openapi.test.ts fails when the exported copy is out of date.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiSpec } from "../packages/core/src/openapi/spec.js";

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "console", "src", "generated", "openapi.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(openApiSpec, null, 2)}\n`);
console.log(`OpenAPI spec written to ${target}`);
