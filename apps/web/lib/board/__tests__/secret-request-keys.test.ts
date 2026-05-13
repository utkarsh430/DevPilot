// The validation the extracted ask loop enforces.
//
// `requestSecrets` itself reaches `transitionTicket` and `supabaseService`, which
// pull `server-only` and cannot load under Vitest — which is precisely why the
// validation lives in its own marker-free module. Everything asserted here used
// to be inline in `app/api/runners/tools/request-secret/route.ts`, where no test
// could reach it.

import { describe, expect, it } from "vitest";
import {
  MAX_SECRET_REQUEST_KEYS,
  SECRET_KEY_RE,
  normalizeSecretRequest,
} from "@/lib/board/secret-request-keys";

const VALID = {
  ticketId: "11111111-2222-3333-4444-555555555555",
  keys: ["DATABASE_URL"],
  rationale: "pnpm dev fails without it",
};

describe("normalizeSecretRequest", () => {
  it("accepts a well-formed request and trims the keys", () => {
    const res = normalizeSecretRequest({ ...VALID, keys: [" DATABASE_URL "] });
    expect(res).toMatchObject({ ok: true, keys: ["DATABASE_URL"], authorId: "claude" });
  });

  it("keeps a legal role slug as the comment author", () => {
    expect(normalizeSecretRequest({ ...VALID, authorId: "backend_engineer" })).toMatchObject({
      authorId: "backend_engineer",
    });
  });

  it("falls back to `claude` for an out-of-shape author", () => {
    // The author id lands in `comments.author_id`, which the reconciler
    // string-matches. An arbitrary string there is a way to impersonate a
    // system author, so an unrecognised one is replaced, not passed through.
    expect(normalizeSecretRequest({ ...VALID, authorId: "devpilot_move_ticket " })).toMatchObject({
      authorId: "claude",
    });
    expect(normalizeSecretRequest({ ...VALID, authorId: 42 })).toMatchObject({
      authorId: "claude",
    });
  });

  it("rejects a missing ticket, empty keys, or a blank rationale", () => {
    expect(normalizeSecretRequest({ ...VALID, ticketId: "" })).toMatchObject({ ok: false });
    expect(normalizeSecretRequest({ ...VALID, keys: [] })).toMatchObject({ ok: false });
    expect(normalizeSecretRequest({ ...VALID, keys: "DATABASE_URL" })).toMatchObject({ ok: false });
    expect(normalizeSecretRequest({ ...VALID, rationale: "   " })).toMatchObject({ ok: false });
  });

  it("bounds the key count", () => {
    const keys = Array.from({ length: MAX_SECRET_REQUEST_KEYS + 1 }, (_, i) => `KEY_${i}`);
    expect(normalizeSecretRequest({ ...VALID, keys })).toMatchObject({ ok: false });
  });

  it("REJECTS an out-of-shape key rather than sanitising it", () => {
    // Rewriting `oops-key` into `OOPS_KEY` would ask the operator for a variable
    // nobody declared, under a name DevPilot invented.
    for (const bad of ["lower_case", "has-dash", "1LEADING_DIGIT", "", "SPACE KEY", "K$"]) {
      expect(normalizeSecretRequest({ ...VALID, keys: [bad] })).toMatchObject({ ok: false });
    }
  });

  it("rejects a non-string key", () => {
    expect(normalizeSecretRequest({ ...VALID, keys: [{ toString: () => "OK" }] })).toMatchObject({
      ok: false,
    });
  });
});

describe("SECRET_KEY_RE", () => {
  it("matches the shape project_secrets and .env.example use", () => {
    expect(SECRET_KEY_RE.test("DATABASE_URL")).toBe(true);
    expect(SECRET_KEY_RE.test("A")).toBe(true);
    expect(SECRET_KEY_RE.test("A1_B2")).toBe(true);
    expect(SECRET_KEY_RE.test(`A${"B".repeat(127)}`)).toBe(true);
    expect(SECRET_KEY_RE.test(`A${"B".repeat(128)}`)).toBe(false);
  });
});
