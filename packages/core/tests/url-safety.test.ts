import { describe, expect, it } from "vitest";
import { UnsafeUrlError, assertPublicHttpUrl, isPrivateAddress } from "../src/security/url-safety.js";

const lookupTo = (...addresses: string[]) => async () => addresses;

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false)
  );
});

describe("assertPublicHttpUrl", () => {
  it("accepts https URLs that resolve publicly", async () => {
    await expect(
      assertPublicHttpUrl("https://hooks.example.com/x", { lookup: lookupTo("93.184.216.34") })
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects http, credentials, and private resolution", async () => {
    await expect(assertPublicHttpUrl("http://hooks.example.com")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(
      assertPublicHttpUrl("https://u:p@hooks.example.com", { lookup: lookupTo("93.184.216.34") })
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(
      assertPublicHttpUrl("https://internal.example.com", { lookup: lookupTo("93.184.216.34", "10.0.0.5") })
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpUrl("https://169.254.169.254/latest/meta-data")).rejects.toBeInstanceOf(
      UnsafeUrlError
    );
  });

  it("allows private http targets only when explicitly enabled", async () => {
    await expect(assertPublicHttpUrl("http://localhost:4000/hook", { allowPrivate: true })).resolves.toBeInstanceOf(
      URL
    );
  });
});
