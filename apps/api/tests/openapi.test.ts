import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { RouteOptions } from "fastify";
import { openApiSpec, UNDOCUMENTED_V1_PREFIXES } from "@tredmail/core/openapi/spec";
import { redisConnection } from "@tredmail/core/queue/redis";
import { buildServer } from "../src/app.js";

// Fastify path (/v1/emails/:id) -> OpenAPI path relative to the server URL (/emails/{id})
const toSpecPath = (url: string) => url.replace(/^\/v1/, "").replace(/\/$/, "").replace(/:(\w+)/g, "{$1}") || "/";

describe("OpenAPI spec", async () => {
  const routes: Array<{ method: string; url: string }> = [];
  const app = await buildServer({
    onRoute: (route: RouteOptions) => {
      for (const method of [route.method].flat()) routes.push({ method: String(method).toLowerCase(), url: route.url });
    },
  });
  await app.ready();
  afterAll(async () => {
    await app.close();
    redisConnection.disconnect();
  });

  const publicRoutes = routes.filter(
    (r) => r.url.startsWith("/v1/") && !["head", "options"].includes(r.method) && !UNDOCUMENTED_V1_PREFIXES.some((p) => r.url.startsWith(p)),
  );
  const paths = openApiSpec.paths as Record<string, Record<string, unknown>>;

  it("documents every public /v1 route", () => {
    expect(publicRoutes.length).toBeGreaterThan(35);
    const missing = publicRoutes
      .map((r) => `${r.method.toUpperCase()} ${toSpecPath(r.url)}`)
      .filter((key) => {
        const [method, path] = key.split(" ");
        return !paths[path]?.[method.toLowerCase()];
      });
    expect([...new Set(missing)]).toEqual([]);
  });

  it("documents no route that does not exist", () => {
    const served = new Set(publicRoutes.map((r) => `${r.method} ${toSpecPath(r.url)}`));
    const phantom = Object.entries(paths).flatMap(([path, methods]) =>
      Object.keys(methods).filter((m) => !served.has(`${m} ${path}`)).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(phantom).toEqual([]);
  });

  it("matches the copy the console renders (run `npm run openapi:export` after changing it)", () => {
    const exported = JSON.parse(readFileSync(new URL("../../console/src/generated/openapi.json", import.meta.url), "utf8"));
    expect(exported).toEqual(JSON.parse(JSON.stringify(openApiSpec)));
  });

  it("is served at /v1/openapi.json without a key", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toBe("3.1.0");
  });
});
