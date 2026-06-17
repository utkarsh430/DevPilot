// Vercel hosting/deploy default — the "no provider committed" web-project frame.
//
// Hand-asserted (not snapshotted) for the same reason as the committed-stack
// frame: every line is a behavioural contract (default-applies, native-tooling
// over self-hosted, and above all "default, NOT a ban — an explicit choice
// wins"), and a snapshot would let all of them drift green in one `-u`.

import { describe, expect, it } from "vitest";
import {
  CONSOLIDATOR_PROMPT,
  LEAD_SYSTEM_PROMPT,
  PANEL_DEVOPS_PROMPT,
  PANEL_PM_PROMPT,
  PANEL_TECH_LEAD_PROMPT,
  type PromptContext,
} from "@/lib/plan/prompts";
import type { StackTag } from "@/lib/plan/types";

function ctx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    projectName: "acme",
    repoUrl: null,
    stackFlavor: "mixed",
    stackPreferences: "",
    stackTags: [],
    stackEcosystem: "unset",
    teamTier: "standard",
    readmeExcerpt: null,
    packageJsonExcerpt: null,
    ...overrides,
  };
}

const HEADING = "# Hosting & deploy default (preference, not a rule)";

// Every prompt the plan pipeline builds. The default is worthless if one of
// them silently misses it — a DevOps panel that never saw it will happily stand
// up Jenkins + Prometheus, which is the exact incident this fixes.
const ALL_PROMPTS = [
  ["lead", LEAD_SYSTEM_PROMPT],
  ["pm", PANEL_PM_PROMPT],
  ["tech_lead", PANEL_TECH_LEAD_PROMPT],
  ["devops", PANEL_DEVOPS_PROMPT],
  ["consolidator", CONSOLIDATOR_PROMPT],
] as const;

describe("Vercel hosting default — when it applies", () => {
  it.each(ALL_PROMPTS)(
    "%s defaults an unclaimed web project to Vercel + native tooling",
    (_name, build) => {
      const out = build(ctx({ projectType: "web", stackEcosystem: "unset" }));
      expect(out).toContain(HEADING);
      expect(out).toContain("default the hosting/deploy target to **Vercel**");
      // The three native-over-self-hosted preferences.
      expect(out).toContain("Vercel's Git-push build & deploy");
      expect(out).toContain("Vercel's instant redeploy of a previous deployment");
      expect(out).toContain("Vercel's native Analytics, Speed Insights, and function logs");
    },
  );

  it("steers away from Jenkins / GitHub-Actions-for-deploy, but keeps a CI check fine", () => {
    const out = PANEL_DEVOPS_PROMPT(ctx({ projectType: "web" }));
    expect(out).toContain("Do NOT stand up a separate deploy pipeline");
    expect(out).toContain("Jenkinsfile");
    // A lint/test CI check is explicitly still encouraged — this is not "no CI".
    expect(out).toContain("that is CI, not a deploy system");
  });

  it("steers away from a self-hosted Prometheus/Grafana stack and says why", () => {
    const out = PANEL_DEVOPS_PROMPT(ctx({ projectType: "web" }));
    expect(out).toContain("Do NOT stand up a self-hosted Prometheus + Grafana stack");
    expect(out).toContain("scale-to-zero serverless functions");
    // The DevOps bias line that used to contradict this now defers to the frame.
    expect(out).toContain('if the "Hosting & deploy default" frame above applies, it wins');
  });

  it("applies to `other` / unset platforms too — the incident had no platform asserted", () => {
    // projectType omitted entirely (the real todo-app case) and explicitly `other`.
    expect(PANEL_DEVOPS_PROMPT(ctx())).toContain(HEADING);
    expect(PANEL_DEVOPS_PROMPT(ctx({ projectType: "other" }))).toContain(HEADING);
  });

  it("still applies under an oss / mixed flavor and an oss / mixed ecosystem", () => {
    for (const stackFlavor of ["oss", "mixed"] as const) {
      expect(PANEL_DEVOPS_PROMPT(ctx({ projectType: "web", stackFlavor }))).toContain(HEADING);
    }
    for (const stackEcosystem of ["oss", "mixed"] as const) {
      expect(PANEL_DEVOPS_PROMPT(ctx({ projectType: "web", stackEcosystem }))).toContain(HEADING);
    }
  });
});

describe("Vercel hosting default — it is a DEFAULT, not a ban", () => {
  it("names the escape hatch: an explicit choice is honoured, not overridden", () => {
    const out = PANEL_TECH_LEAD_PROMPT(ctx({ projectType: "web" }));
    expect(out).toContain("This is a default, not a rule.");
    expect(out).toContain("never override an explicit selection with Vercel");
    // The alternative targets are named so the model knows what "explicit" means.
    expect(out).toContain("Render, Fly.io, Railway");
  });
});

describe("Vercel hosting default — when an explicit choice suppresses it", () => {
  it("a committed cloud ecosystem wins — no Vercel default", () => {
    for (const stackEcosystem of ["aws", "azure", "gcp"] as const) {
      const out = PANEL_DEVOPS_PROMPT(ctx({ projectType: "web", stackEcosystem }));
      expect(out).not.toContain(HEADING);
      expect(out).not.toContain("default the hosting/deploy target to **Vercel**");
    }
  });

  it("a pinned compute service in the stack tags wins — no Vercel default", () => {
    // AWS Lambda fills `compute_serverless`; the operator has already chosen a host.
    const lambda: StackTag = {
      provider: "aws",
      serviceKey: "aws_lambda",
      label: "AWS Lambda",
      source: "user_override",
      capability: "compute_serverless",
    };
    const out = PANEL_DEVOPS_PROMPT(
      ctx({ projectType: "web", stackEcosystem: "unset", stackTags: [lambda] }),
    );
    expect(out).not.toContain(HEADING);
  });

  it("a non-compute stack tag does NOT suppress the default", () => {
    // A pinned cache says nothing about hosting — Vercel is still the default.
    const redis: StackTag = {
      provider: "oss",
      serviceKey: "redis",
      label: "Redis",
      source: "manual",
      capability: "cache",
    };
    const out = PANEL_DEVOPS_PROMPT(
      ctx({ projectType: "web", stackEcosystem: "unset", stackTags: [redis] }),
    );
    expect(out).toContain(HEADING);
  });

  it("mobile / ios / desktop platforms never see it — they have no web host to default", () => {
    for (const projectType of ["mobile", "ios", "desktop"] as const) {
      expect(PANEL_DEVOPS_PROMPT(ctx({ projectType }))).not.toContain(HEADING);
    }
  });
});
