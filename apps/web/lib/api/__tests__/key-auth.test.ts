// The API-key vendor tag is a one-way door.
//
// `DEVPILOT_KEY_VENDOR`'s VALUE is the literal "ace", and it sits inside the
// sha256 preimage of every issued key. The DevPilot rename renamed the SYMBOL
// and deliberately left the value alone; these tests fail if anyone changes it,
// because the failure they would otherwise cause is silent at build time and
// unrecoverable at runtime (see the comment on the const itself).

import { describe, it, expect, vi } from "vitest";

// key-auth.ts imports supabaseService at module scope, which drags in
// next/headers. These tests only exercise the pure mint/parse/hash path.
vi.mock("@/lib/db/server", () => ({ supabaseService: () => ({}) }));

import {
  DEVPILOT_KEY_VENDOR,
  DEVPILOT_KEY_PREFIX_LEN,
  mintApiKey,
  parseAuthorizationHeader,
  sha256,
} from "@/lib/api/key-auth";

describe("API key vendor tag", () => {
  it("is still the literal 'ace' — the sha256 preimage of every issued key", () => {
    expect(DEVPILOT_KEY_VENDOR).toBe("ace");
  });

  it("accepts an existing `ace_<prefix>_<secret>` key", () => {
    const secret = "a".repeat(43);
    const cleartext = `ace_${secret.slice(0, DEVPILOT_KEY_PREFIX_LEN)}_${secret}`;
    const parsed = parseAuthorizationHeader(`Bearer ${cleartext}`);
    expect(parsed).not.toBeNull();
    expect(parsed?.vendor).toBe("ace");
    expect(parsed?.cleartext).toBe(cleartext);
  });

  it("mints keys whose stored hash is sha256 of the presented cleartext", () => {
    const { cleartext, hash, prefix } = mintApiKey();
    expect(cleartext.startsWith("ace_")).toBe(true);
    expect(prefix).toHaveLength(DEVPILOT_KEY_PREFIX_LEN);
    // resolveApiKey hashes the PRESENTED string; that must reproduce the hash
    // stored at mint time, or the key is dead with no way to re-derive it.
    expect(sha256(parseAuthorizationHeader(`Bearer ${cleartext}`)!.cleartext)).toBe(hash);
  });

  it("rejects a key carrying any other vendor tag", () => {
    const secret = "b".repeat(43);
    const other = `devpilot_${secret.slice(0, DEVPILOT_KEY_PREFIX_LEN)}_${secret}`;
    expect(parseAuthorizationHeader(`Bearer ${other}`)).toBeNull();
  });
});

// Regression: the parser used to `split("_")`, which misparses a key whose
// base64url prefix/secret legitimately contains `_`. It rejected ~12% of valid
// freshly-minted keys — the source of this suite's ~1-in-8 flakiness.
//
// Everything below is DETERMINISTIC. A single mint proves nothing about a
// probabilistic bug, so the round-trip runs a large loop (P(miss) = (63/64)^(8*500),
// i.e. astronomically small) and the `_`-bearing shapes are also asserted
// directly with hand-built keys, which is what makes the guard airtight rather
// than merely very likely.
describe("API key parsing — underscores in the base64url prefix/secret", () => {
  const ROUNDS = 500;

  it(`round-trips ${ROUNDS} freshly-minted keys: every one parses and re-derives its hash`, () => {
    const failures: string[] = [];

    for (let i = 0; i < ROUNDS; i++) {
      const { cleartext, hash, prefix } = mintApiKey();
      const parsed = parseAuthorizationHeader(`Bearer ${cleartext}`);

      if (!parsed) {
        failures.push(`rejected a valid key: ${cleartext}`);
        continue;
      }
      // The prefix is the DB lookup hint — a wrong one silently misses the row.
      if (parsed.prefix !== prefix) {
        failures.push(`prefix mismatch: parsed ${parsed.prefix}, minted ${prefix}`);
      }
      // The hash is over the FULL cleartext; any normalisation kills the key.
      if (sha256(parsed.cleartext) !== hash) {
        failures.push(`hash did not re-derive for ${cleartext}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("parses a key whose 8-char prefix contains an underscore", () => {
    // The exact shape that broke split("_"): parts[1] would be "ab" (len 2),
    // fail the length check, and the key would be rejected outright.
    const secret = `ab_de${"f".repeat(38)}`;
    expect(secret).toHaveLength(43);
    const prefix = secret.slice(0, DEVPILOT_KEY_PREFIX_LEN); // "ab_defff"
    expect(prefix).toContain("_");

    const cleartext = `${DEVPILOT_KEY_VENDOR}_${prefix}_${secret}`;
    const parsed = parseAuthorizationHeader(`Bearer ${cleartext}`);

    expect(parsed).not.toBeNull();
    expect(parsed?.vendor).toBe(DEVPILOT_KEY_VENDOR);
    expect(parsed?.prefix).toBe(prefix);
    expect(parsed?.cleartext).toBe(cleartext);
  });

  it("parses a key whose secret body contains underscores past the prefix", () => {
    const secret = `abcdefgh_${"i".repeat(20)}_${"j".repeat(13)}`;
    expect(secret).toHaveLength(43);
    const cleartext = `${DEVPILOT_KEY_VENDOR}_${secret.slice(0, DEVPILOT_KEY_PREFIX_LEN)}_${secret}`;
    const parsed = parseAuthorizationHeader(`Bearer ${cleartext}`);

    expect(parsed?.prefix).toBe("abcdefgh");
    // Returned in full and unaltered — the stored hash covers the whole string.
    expect(parsed?.cleartext).toBe(cleartext);
  });

  it("still rejects malformed shapes (the fix must not weaken any check)", () => {
    const secret = "c".repeat(43);
    const prefix = secret.slice(0, DEVPILOT_KEY_PREFIX_LEN);

    // No vendor delimiter at all.
    expect(parseAuthorizationHeader("Bearer acedeadbeef")).toBeNull();
    // Empty vendor (leading underscore).
    expect(parseAuthorizationHeader(`Bearer _${prefix}_${secret}`)).toBeNull();
    // Prefix shorter than the fixed width.
    expect(parseAuthorizationHeader(`Bearer ace_short_${secret}`)).toBeNull();
    // Prefix present but no delimiter after it, so the shape isn't a key.
    expect(parseAuthorizationHeader(`Bearer ace_${prefix}${secret}`)).toBeNull();
    // Empty secret.
    expect(parseAuthorizationHeader(`Bearer ace_${prefix}_`)).toBeNull();
    // Wrong scheme / no token.
    expect(parseAuthorizationHeader(`Basic ace_${prefix}_${secret}`)).toBeNull();
    expect(parseAuthorizationHeader("Bearer")).toBeNull();
    expect(parseAuthorizationHeader(null)).toBeNull();
  });
});
