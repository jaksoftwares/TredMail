import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TREDMAIL_VERSION } from "../src/config/version.js";

const versionOf = (path: string) => (JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { version: string }).version;

describe("platform version", () => {
  it("matches every package released with the platform", () => {
    for (const path of [
      "../../../package.json",
      "../../../apps/api/package.json",
      "../../../apps/worker/package.json",
      "../../../apps/smtp-relay/package.json",
      "../../../apps/console/package.json",
    ]) {
      expect(versionOf(path), path).toBe(TREDMAIL_VERSION);
    }
  });
});
