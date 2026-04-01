// SSRF guard (security criterion 2). These are the checks that stand between an
// operator-supplied string and a server-side fetch from inside our network, so
// they get tested as adversarially as they're meant to behave.

import { describe, expect, it } from "vitest";
import {
  allAddressesPublic,
  checkLlmBaseUrl,
  isBlockedIp,
  DEFAULT_BASE_URL_POLICY,
  type BaseUrlPolicy,
} from "@/lib/llm/base-url";

const LOCAL: BaseUrlPolicy = { allowLocal: true, hostAllowlist: [] };

describe("checkLlmBaseUrl — scheme + shape", () => {
  it("accepts a plain https endpoint and normalizes it", () => {
    const res = checkLlmBaseUrl("https://api.example.com/v1/", DEFAULT_BASE_URL_POLICY);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.normalized).toBe("https://api.example.com/v1");
  });

  it("rejects http by default", () => {
    const res = checkLlmBaseUrl("http://api.example.com/v1", DEFAULT_BASE_URL_POLICY);
    expect(res).toMatchObject({ ok: false, reason: "http_not_allowed" });
  });

  it("rejects non-http schemes outright (file:, gopher:, data:)", () => {
    for (const raw of ["file:///etc/passwd", "gopher://x.com/", "data:text/plain,hi"]) {
      expect(checkLlmBaseUrl(raw, DEFAULT_BASE_URL_POLICY).ok).toBe(false);
    }
  });

  it("rejects credentials embedded in the URL", () => {
    const res = checkLlmBaseUrl("https://user:pass@api.example.com/v1", DEFAULT_BASE_URL_POLICY);
    expect(res).toMatchObject({ ok: false, reason: "credentials_in_url" });
  });

  it("rejects a query string or fragment — we append paths to this origin", () => {
    expect(
      checkLlmBaseUrl("https://api.example.com/v1?x=1", DEFAULT_BASE_URL_POLICY),
    ).toMatchObject({ ok: false, reason: "query_or_fragment" });
    expect(checkLlmBaseUrl("https://api.example.com/v1#f", DEFAULT_BASE_URL_POLICY)).toMatchObject({
      ok: false,
      reason: "query_or_fragment",
    });
  });

  it("rejects internal-sounding hostnames by name, even over https", () => {
    for (const host of [
      "https://vault.internal/v1",
      "https://printer.local/v1",
      "https://metadata.google.internal/v1",
      "https://db.home.arpa/v1",
    ]) {
      expect(checkLlmBaseUrl(host, DEFAULT_BASE_URL_POLICY).ok).toBe(false);
    }
  });

  it("rejects localhost unless the dev allowlist is on — including over https", () => {
    expect(checkLlmBaseUrl("https://localhost:11434", DEFAULT_BASE_URL_POLICY)).toMatchObject({
      ok: false,
      reason: "private_host",
    });
    expect(checkLlmBaseUrl("http://localhost:11434", LOCAL).ok).toBe(true);
    expect(checkLlmBaseUrl("http://127.0.0.1:11434/v1", LOCAL).ok).toBe(true);
  });

  it("still refuses a NON-loopback http host under the dev allowlist", () => {
    // The allowlist opens localhost, not plaintext-http-in-general.
    expect(checkLlmBaseUrl("http://api.example.com/v1", LOCAL)).toMatchObject({
      ok: false,
      reason: "http_not_allowed",
    });
  });

  it("enforces the optional host allowlist when configured", () => {
    const pinned: BaseUrlPolicy = {
      allowLocal: false,
      hostAllowlist: ["api.openai.com", ".corp.example.com"],
    };
    expect(checkLlmBaseUrl("https://api.openai.com/v1", pinned).ok).toBe(true);
    expect(checkLlmBaseUrl("https://llm.corp.example.com/v1", pinned).ok).toBe(true);
    expect(checkLlmBaseUrl("https://evil.com/v1", pinned)).toMatchObject({
      ok: false,
      reason: "not_allowlisted",
    });
  });
});

describe("isBlockedIp — the check that actually holds", () => {
  it("blocks every private / loopback / link-local / CGNAT / metadata IPv4 range", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata — the one that matters most
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "192.0.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "104.18.0.1", "172.32.0.1", "192.167.1.1"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 loopback, ULA, link-local and multicast", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("unwraps IPv4-mapped IPv6 — ::ffff:169.254.169.254 must not sneak past", () => {
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
    // …and the mapped form of a PUBLIC address is still fine.
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("unwraps NAT64 and 6to4 embeddings too", () => {
    expect(isBlockedIp("64:ff9b::169.254.169.254")).toBe(true);
    expect(isBlockedIp("2002:a00:1::1")).toBe(true); // 6to4 wrapping 10.0.0.1
  });

  it("allows public IPv6", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });

  it("FAILS CLOSED on anything it can't parse", () => {
    for (const junk of ["", "not-an-ip", "999.999.999.999", "1.2.3", "::gg"]) {
      expect(isBlockedIp(junk), junk).toBe(true);
    }
  });
});

describe("allAddressesPublic", () => {
  it("rejects when ANY resolved address is private — a mixed record is a rebinding setup", () => {
    expect(allAddressesPublic(["8.8.8.8", "127.0.0.1"])).toBe(false);
  });

  it("rejects an empty resolution rather than treating it as safe", () => {
    expect(allAddressesPublic([])).toBe(false);
  });

  it("accepts an all-public record set", () => {
    expect(allAddressesPublic(["8.8.8.8", "2606:4700:4700::1111"])).toBe(true);
  });
});
