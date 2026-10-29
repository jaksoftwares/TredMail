import { describe, expect, it } from "vitest";
import { HEARTBEAT_STALE_MS, workerHealth } from "../src/services/heartbeat.js";
import { alertChatText } from "../src/services/ops-alerts.js";

describe("worker heartbeat", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");

  it("reports a recent heartbeat as ok", () => {
    expect(workerHealth(String(now - 60_000), now)).toEqual({ status: "ok", last_heartbeat: "2026-11-10T11:59:00.000Z", age_seconds: 60 });
  });

  it("reports a stale or missing heartbeat as down", () => {
    expect(workerHealth(String(now - HEARTBEAT_STALE_MS - 1000), now).status).toBe("down");
    expect(workerHealth(null, now)).toEqual({ status: "down", last_heartbeat: null, age_seconds: null });
    expect(workerHealth("garbage", now).status).toBe("down");
  });
});

describe("operations alerts", () => {
  it("formats an alert for chat with the installation it comes from", () => {
    const text = alertChatText({ title: "Bounce rate is 9.00%", summary: "45 of 500 bounced.", details: ["Check the Emails page."] }, "api.tredmail.example");
    expect(text).toBe("*[TredMail alert · api.tredmail.example] Bounce rate is 9.00%*\n45 of 500 bounced.\n• Check the Emails page.");
  });
});
