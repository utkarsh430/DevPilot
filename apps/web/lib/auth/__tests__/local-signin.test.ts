// The gate on instant sign-in. Every branch here is a way a real deployment
// could otherwise end up with a route that signs anyone in as anyone.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LOCAL_PASSWORDLESS_FLAG,
  decideLocalSignin,
  isPlausibleEmail,
  localSigninFromEnv,
  originFromHeaders,
  safeNextPath,
} from "@/lib/auth/local-signin";

const LOCAL = "http://127.0.0.1:54321";
const HOSTED = "https://abcdefgh.supabase.co";

describe("decideLocalSignin", () => {
  it("is OFF by default, even on a loopback Supabase", () => {
    expect(decideLocalSignin({ flag: undefined, supabaseUrl: LOCAL })).toEqual({
      allowed: false,
      reason: "flag-off",
    });
    expect(decideLocalSignin({ flag: "", supabaseUrl: LOCAL }).allowed).toBe(false);
    expect(decideLocalSignin({ flag: "yes", supabaseUrl: LOCAL }).allowed).toBe(false);
    expect(decideLocalSignin({ flag: "0", supabaseUrl: LOCAL }).allowed).toBe(false);
  });

  it("the flag alone is NOT enough: a hosted Supabase is refused", () => {
    expect(decideLocalSignin({ flag: "1", supabaseUrl: HOSTED })).toEqual({
      allowed: false,
      reason: "supabase-not-loopback",
    });
    expect(decideLocalSignin({ flag: "1", supabaseUrl: "" }).allowed).toBe(false);
    expect(
      decideLocalSignin({ flag: "1", supabaseUrl: "http://127.0.0.1.evil.example" }).allowed,
    ).toBe(false);
  });

  it("flag + loopback Supabase → allowed (the control)", () => {
    expect(decideLocalSignin({ flag: "1", supabaseUrl: LOCAL })).toEqual({ allowed: true });
    expect(decideLocalSignin({ flag: "true", supabaseUrl: "http://localhost:54321" }).allowed).toBe(
      true,
    );
  });

  it("localSigninFromEnv reads the named flag", () => {
    expect(localSigninFromEnv({ NEXT_PUBLIC_SUPABASE_URL: LOCAL }).allowed).toBe(false);
    expect(
      localSigninFromEnv({ NEXT_PUBLIC_SUPABASE_URL: LOCAL, [LOCAL_PASSWORDLESS_FLAG]: "1" })
        .allowed,
    ).toBe(true);
  });
});

describe("inputs", () => {
  it("safeNextPath keeps same-origin paths and nothing else", () => {
    expect(safeNextPath("/settings/github-integration")).toBe("/settings/github-integration");
    expect(safeNextPath(undefined)).toBe("/board");
    expect(safeNextPath("https://evil.example/")).toBe("/board");
    expect(safeNextPath("//evil.example/")).toBe("/board");
    expect(safeNextPath("/\\evil.example")).toBe("/board");
  });

  it("originFromHeaders follows the Host the browser used, never the fallback when one is given", () => {
    const h = (m: Record<string, string>) => ({ get: (n: string) => m[n.toLowerCase()] ?? null });
    expect(originFromHeaders(h({ host: "127.0.0.1:3000" }), "http://localhost:3000")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(
      originFromHeaders(
        h({ host: "x", "x-forwarded-host": "app.example", "x-forwarded-proto": "https" }),
        "http://f",
      ),
    ).toBe("https://app.example");
    expect(originFromHeaders(h({}), "http://localhost:3000")).toBe("http://localhost:3000");
    expect(originFromHeaders(h({ host: "evil host/with space" }), "http://f")).toBe("http://f");
  });

  it("isPlausibleEmail", () => {
    expect(isPlausibleEmail("me@example.com")).toBe(true);
    expect(isPlausibleEmail("not an email")).toBe(false);
  });
});

describe("the route checks the gate before it touches the admin API", () => {
  // `app/auth/local/route.ts` reaches next/server + the service client and
  // cannot load here, so the ordering is pinned by reading the source.
  const src = readFileSync(
    fileURLToPath(new URL("../../../app/auth/local/route.ts", import.meta.url)),
    "utf8",
  );

  it("gate first, then createUser / generateLink / verifyOtp", () => {
    // Search the handler BODY, not the header comment that narrates it.
    const body = src.slice(src.indexOf("export async function POST"));
    const gate = body.indexOf("localSigninFromEnv(");
    const create = body.indexOf("admin.createUser(");
    const link = body.indexOf("admin.generateLink(");
    const verify = body.indexOf("verifyOtp(");
    expect(gate).toBeGreaterThan(-1);
    for (const idx of [create, link, verify]) {
      expect(idx).toBeGreaterThan(gate);
    }
  });

  it("refuses with a 404, not a redirect that would reveal the route exists", () => {
    expect(src).toMatch(/status:\s*404/);
  });
});
