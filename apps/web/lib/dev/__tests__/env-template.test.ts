// The rule that makes `pnpm setup:local` safe to re-run: a value that is
// already set is never touched. Everything else here is what keeps the
// template (`.env.example`) and the bootstrap from drifting apart.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETUP_BANNER, fillEnvTemplate, missingKeys, parseDotenv } from "@/lib/dev/env-template";
import {
  LOCAL_APP_URL,
  REQUIRED_LOCAL_ENV_KEYS,
  buildLocalEnvValues,
  generateLocalSecrets,
} from "@/lib/dev/local-stack";

const TEMPLATE_PATH = fileURLToPath(new URL("../../../../../.env.example", import.meta.url));

describe("fillEnvTemplate — in-place fill", () => {
  it("fills a blank key in place and leaves the comment above it", () => {
    const src = "# the key\nKEY=\nOTHER=x\n";
    const { content, report } = fillEnvTemplate(src, { KEY: "v" });
    expect(content).toBe("# the key\nKEY=v\nOTHER=x\n");
    expect(report).toEqual([{ key: "KEY", action: "set" }]);
  });

  it("never overwrites a set value — with a live-writer control", () => {
    const kept = fillEnvTemplate("KEY=old\n", { KEY: "new" });
    expect(kept.content).toBe("KEY=old\n");
    expect(kept.report).toEqual([{ key: "KEY", action: "kept" }]);

    // CONTROL: the same values against a blank key DO land, so the assertion
    // above is not passing because the function is a no-op.
    const set = fillEnvTemplate("KEY=\n", { KEY: "new" });
    expect(set.content).toBe("KEY=new\n");
    expect(set.report).toEqual([{ key: "KEY", action: "set" }]);
  });

  it("treats a quoted empty string as blank", () => {
    const { content, report } = fillEnvTemplate('KEY=""\n', { KEY: "v" });
    expect(content).toBe("KEY=v\n");
    expect(report[0]?.action).toBe("set");
  });

  it("acts on the LAST active occurrence, which is the one the loaders use", () => {
    const { content } = fillEnvTemplate("KEY=first\nKEY=\n", { KEY: "v" });
    expect(content).toBe("KEY=first\nKEY=v\n");
    expect(parseDotenv(content).KEY).toBe("v");
  });

  it("uncomments `# INNGEST_DEV=1` rather than appending a duplicate", () => {
    const src = "# docs\n# INNGEST_DEV=1\n";
    const { content, report } = fillEnvTemplate(src, { INNGEST_DEV: "1" });
    expect(content).toBe("# docs\nINNGEST_DEV=1\n");
    expect(report).toEqual([{ key: "INNGEST_DEV", action: "uncommented" }]);
    expect(content.match(/^INNGEST_DEV=/gm)).toHaveLength(1);
  });

  it("prefers an active blank line over a commented one", () => {
    const src = "# KEY=doc-example\nKEY=\n";
    const { content } = fillEnvTemplate(src, { KEY: "v" });
    expect(content).toBe("# KEY=doc-example\nKEY=v\n");
  });

  it("appends unknown keys under one banner, and a second fill appends nothing", () => {
    const first = fillEnvTemplate("A=1\n", { NEW_ONE: "x", NEW_TWO: "y" });
    expect(first.content).toBe(`A=1\n\n${SETUP_BANNER}\nNEW_ONE=x\nNEW_TWO=y\n`);
    expect(first.report.map((r) => r.action)).toEqual(["appended", "appended"]);

    const second = fillEnvTemplate(first.content, { NEW_ONE: "x", NEW_TWO: "y" });
    expect(second.content).toBe(first.content);
    expect(second.report.map((r) => r.action)).toEqual(["kept", "kept"]);
    expect(second.content.match(new RegExp(SETUP_BANNER, "g"))).toHaveLength(1);
  });

  it("reuses an existing banner for later additions", () => {
    const src = `A=1\n\n${SETUP_BANNER}\nNEW_ONE=x\n`;
    const { content } = fillEnvTemplate(src, { NEW_TWO: "y" });
    expect(content).toBe(`A=1\n\n${SETUP_BANNER}\nNEW_ONE=x\nNEW_TWO=y\n`);
  });

  it("is idempotent: fill(fill(x)) === fill(x)", () => {
    const src = "# a\nA=\n# INNGEST_DEV=1\nB=keep\n";
    const values = { A: "1", INNGEST_DEV: "1", B: "ignored", C: "appended" };
    const once = fillEnvTemplate(src, values).content;
    const twice = fillEnvTemplate(once, values).content;
    expect(twice).toBe(once);
  });

  it("serialises values that need quoting and refuses `$`", () => {
    const { content } = fillEnvTemplate("KEY=\n", { KEY: 'has space # and "quote"' });
    expect(content).toBe('KEY="has space # and \\"quote\\""\n');
    expect(parseDotenv(content).KEY).toBe('has space # and "quote"');
    expect(() => fillEnvTemplate("KEY=\n", { KEY: "a$b" })).toThrow(/\$/);
  });

  it("round-trips through parseDotenv", () => {
    const { content } = fillEnvTemplate("A=\nexport B=\n# C=1\n", {
      A: "plain",
      B: "with space",
      C: "1",
    });
    expect(parseDotenv(content)).toEqual({ A: "plain", B: "with space", C: "1" });
  });
});

describe("parseDotenv", () => {
  it("skips comments and blanks, accepts `export`, decodes quotes, last wins", () => {
    const env = parseDotenv(
      [
        "# comment",
        "",
        "A=1",
        "export B=two",
        'C="quoted \\"inner\\" value"',
        "D='single # not a comment'",
        "E=bare # trailing comment",
        "A=2",
      ].join("\n"),
    );
    expect(env).toEqual({
      A: "2",
      B: "two",
      C: 'quoted "inner" value',
      D: "single # not a comment",
      E: "bare",
    });
  });
});

describe("missingKeys", () => {
  it("treats blank as missing and set as present", () => {
    expect(missingKeys({ A: "x", B: "", C: "   " }, ["A", "B", "C", "D"])).toEqual(["B", "C", "D"]);
  });
});

describe("template drift — `.env.example` is what setup fills", () => {
  const template = readFileSync(TEMPLATE_PATH, "utf8");

  it("has a home for every required key (blank, preset, or commented out)", () => {
    const active = parseDotenv(template);
    for (const key of REQUIRED_LOCAL_ENV_KEYS) {
      const commented = new RegExp(`^#\\s*${key}=`, "m").test(template);
      expect(key in active || commented, `${key} is not in .env.example`).toBe(true);
    }
  });

  it("presets the two app URLs to 127.0.0.1 — fill never overwrites, so the preset IS the value", () => {
    const active = parseDotenv(template);
    expect(active.NEXT_PUBLIC_APP_URL).toBe(LOCAL_APP_URL);
    expect(active.LOCAL_CC_ENGINE_URL).toBe(LOCAL_APP_URL);
  });

  it("every value setup writes lands in an existing slot — nothing is appended", () => {
    const values = buildLocalEnvValues({
      supabase: {
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
        SUPABASE_SECRET_KEY: "sb_secret_x",
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        NEXT_PUBLIC_LOCAL_MAIL_URL: "http://127.0.0.1:54324",
      },
      secrets: generateLocalSecrets((n) => Buffer.alloc(n, 7)),
      tenantId: "00000000-0000-4000-8000-000000000000",
      runnerName: "local-cc-test",
    });
    const { content, report } = fillEnvTemplate(template, values);
    expect(report.filter((r) => r.action === "appended")).toEqual([]);
    expect(missingKeys(parseDotenv(content), REQUIRED_LOCAL_ENV_KEYS)).toEqual([]);
  });
});
