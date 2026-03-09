// Phase 2 / M5g — flat catalog of every registered role with a coarse UI
// grouping and a short "what this role uniquely picks up" phrase.
//
// Two consumers:
//
//   1. The RoleSelect combobox in the ticket drawer (other agent / UI) reads
//      `groupCatalogByCategory()` to render section headers + tooltips.
//
//   2. `lib/engine/ticket-role-classifier.ts` (M5h) renders this catalog into
//      the Haiku classifier prompt and constrains the Zod enum to the slug
//      list, so the model can only return a known role.
//
// Invariant: every key in `ROLES` (lib/roles/index.ts) MUST have a catalog
// entry. The runtime check at the bottom of this file fails fast in
// development if anyone adds a role to ROLES without updating the catalog.

import { ROLES } from "@/lib/roles/index";

export type RoleCategory =
  | "Workflow"
  | "Leadership / Product"
  | "Engineering"
  | "Data"
  | "Infrastructure"
  | "Quality + Security"
  | "Design"
  | "Go-to-Market"
  | "Operations"
  | "Platform";

export type RoleCatalogEntry = {
  slug: string;
  displayName: string;
  /** Coarse grouping for the UI (RoleSelect combobox sections). */
  category: RoleCategory;
  /** Short purpose phrase for the LLM classifier prompt + the UI tooltip. */
  purpose: string;
};

// Order within each category is the order rendered in the combobox. We list
// "workflow" first because those are the roles that make the canonical
// PM→Engineer→QA loop run; specialists follow grouped by domain.
export const ROLE_CATALOG: RoleCatalogEntry[] = [
  // ─── Workflow ─────────────────────────────────────────────────────────
  // The original PM/Engineer/QA loop + sibling-reviewer set. These are the
  // roles the dispatcher state machine routes between by default.
  {
    slug: "pm",
    displayName: "PM",
    category: "Workflow",
    purpose:
      "Refines rough ticket descriptions into a structured Title/Description/Acceptance-Criteria shape",
  },
  {
    slug: "engineer",
    displayName: "Engineer",
    category: "Workflow",
    purpose:
      "Generic full-stack catchall when no specialist is more appropriate — implements code from a refined ticket",
  },
  {
    slug: "qa",
    displayName: "QA",
    category: "Workflow",
    purpose:
      "Reviews engineer output, runs tests in the workspace, approves to done or rejects with retry feedback",
  },
  {
    slug: "verifier",
    displayName: "Verifier",
    category: "Workflow",
    purpose:
      "Runs the project's build + smoke-check after QA approves so a ticket can't be marked done if the app fails to boot (e.g. missing operator-side env vars)",
  },
  {
    slug: "release_engineer",
    displayName: "Release Engineer",
    category: "Workflow",
    purpose:
      "Auto-spawned when a push rebase fails. Resolves conflict markers across the conflicted files and returns a clean branch ready to retry the push.",
  },
  {
    slug: "triage",
    displayName: "Triage",
    category: "Workflow",
    purpose:
      "Inspects an inbound ticket and emits a branch signal (small_change / spike / needs_design) for routing",
  },
  {
    slug: "tech_lead",
    displayName: "Tech Lead",
    category: "Workflow",
    purpose:
      "Reviews architectural choices on a ticket-by-ticket basis, sets engineering direction, unblocks engineers",
  },
  {
    slug: "security",
    displayName: "Security",
    category: "Workflow",
    purpose:
      "Sibling reviewer in the parallel fan-out cohort — checks engineer diffs for auth/crypto/injection issues",
  },

  // ─── Leadership / Product ────────────────────────────────────────────
  {
    slug: "cto",
    displayName: "CTO",
    category: "Leadership / Product",
    purpose:
      "Technical strategy memos, RFCs, build-vs-buy decisions, architectural call-outs at company scope",
  },
  {
    slug: "vp_engineering",
    displayName: "VP Engineering",
    category: "Leadership / Product",
    purpose:
      "Org-wide engineering planning, headcount and team-shape decisions, escalation owner across squads",
  },
  {
    slug: "engineering_manager",
    displayName: "Engineering Manager",
    category: "Leadership / Product",
    purpose:
      "Owns a single squad's delivery: sprint planning, 1:1 prompts, capacity calls, single-squad retros",
  },
  {
    slug: "product_manager",
    displayName: "Product Manager",
    category: "Leadership / Product",
    purpose:
      "Writes PRDs, prioritizes the backlog, defines the why and what for a product area or feature line",
  },
  {
    slug: "technical_product_manager",
    displayName: "Technical PM",
    category: "Leadership / Product",
    purpose:
      "Authors developer-facing PRDs for platform/API features, balances tech debt vs new capability",
  },
  {
    slug: "product_owner",
    displayName: "Product Owner",
    category: "Leadership / Product",
    purpose:
      "Owns the sprint backlog at story granularity, accepts/rejects completed stories against acceptance criteria",
  },

  // ─── Engineering ─────────────────────────────────────────────────────
  // Specialists. Prefer these over the generic `engineer` when the ticket
  // is clearly in their lane.
  {
    slug: "frontend_engineer",
    displayName: "Frontend Engineer",
    category: "Engineering",
    purpose:
      "React/Next.js UI work — pages, components, Tailwind, shadcn, accessibility, responsive design",
  },
  {
    slug: "backend_engineer",
    displayName: "Backend Engineer",
    category: "Engineering",
    purpose:
      "Server-side: Next.js API routes, server actions, Supabase Postgres queries, Inngest functions",
  },
  {
    slug: "fullstack_engineer",
    displayName: "Fullstack Engineer",
    category: "Engineering",
    purpose:
      "End-to-end feature work spanning UI, server actions, schema migrations, and tests in one ticket",
  },
  {
    slug: "mobile_engineer",
    displayName: "Mobile Engineer",
    category: "Engineering",
    purpose:
      "iOS, Android, or React Native work — native UI, mobile-specific APIs, app-store release tasks",
  },
  {
    slug: "staff_engineer",
    displayName: "Staff Engineer",
    category: "Engineering",
    purpose:
      "Cross-cutting refactors, performance investigations, technical proposals that affect multiple services",
  },
  {
    slug: "software_architect",
    displayName: "Software Architect",
    category: "Engineering",
    purpose:
      "System-level design docs, integration patterns, evaluating frameworks, defining service boundaries",
  },

  // ─── Data ─────────────────────────────────────────────────────────────
  {
    slug: "dataeng",
    displayName: "Data Engineer",
    category: "Data",
    purpose:
      "ETL/ELT pipelines, ingestion jobs, warehouse schemas, dbt models, batch and streaming infrastructure",
  },
  {
    slug: "data_scientist",
    displayName: "Data Scientist",
    category: "Data",
    purpose:
      "Statistical modeling, hypothesis tests, experiment analysis, exploratory notebooks for product questions",
  },
  {
    slug: "data_analyst",
    displayName: "Data Analyst",
    category: "Data",
    purpose:
      "Ad-hoc SQL, dashboards, KPI definitions, slice-and-dice business questions against the warehouse",
  },
  {
    slug: "ml_engineer",
    displayName: "ML Engineer",
    category: "Data",
    purpose:
      "Productionizing models, training pipelines, feature stores, model serving infrastructure and monitoring",
  },
  {
    slug: "analytics_engineer",
    displayName: "Analytics Engineer",
    category: "Data",
    purpose:
      "dbt-style transformation layer, metric definitions, cleaning raw warehouse tables for downstream BI",
  },

  // ─── Infrastructure ──────────────────────────────────────────────────
  {
    slug: "sre",
    displayName: "SRE",
    category: "Infrastructure",
    purpose:
      "Reliability, on-call runbooks, SLO/SLI definitions, incident response, postmortems, observability gaps",
  },
  {
    slug: "cloud_engineer",
    displayName: "Cloud Engineer",
    category: "Infrastructure",
    purpose:
      "AWS/GCP/Azure provisioning, Terraform/Pulumi IaC, VPC and IAM design, cloud-cost optimization",
  },
  {
    slug: "platform_engineer",
    displayName: "Platform Engineer",
    category: "Infrastructure",
    purpose:
      "Internal developer platform, CI/CD pipelines, build tooling, golden-path templates for application teams",
  },
  {
    slug: "dba",
    displayName: "DBA",
    category: "Infrastructure",
    purpose:
      "Database schema changes, query performance tuning, index strategy, replication, backup and restore",
  },

  // ─── Quality + Security ──────────────────────────────────────────────
  {
    slug: "qa_automation_engineer",
    displayName: "QA Automation Engineer",
    category: "Quality + Security",
    purpose:
      "End-to-end test suites in Playwright/Cypress, integration coverage, CI test infrastructure and flakiness",
  },
  {
    slug: "sdet",
    displayName: "SDET",
    category: "Quality + Security",
    purpose:
      "Test framework engineering, shared fixtures, contract tests, building tools that let other QAs scale",
  },
  {
    slug: "security_engineer",
    displayName: "Security Engineer",
    category: "Quality + Security",
    purpose:
      "Threat models, secrets handling, dependency CVE triage, security tooling, hardening production systems",
  },
  {
    slug: "appsec_engineer",
    displayName: "AppSec Engineer",
    category: "Quality + Security",
    purpose:
      "Application-layer security reviews, OWASP-style audits, code-level vulnerability fixes, security tests",
  },
  {
    slug: "compliance_grc",
    displayName: "Compliance / GRC",
    category: "Quality + Security",
    purpose:
      "SOC 2, GDPR, HIPAA audit prep, control mapping, evidence collection, policy and procedure documents",
  },

  // ─── Design ──────────────────────────────────────────────────────────
  {
    slug: "designer",
    displayName: "Designer",
    category: "Design",
    purpose:
      "Generic visual / interaction design work when the ticket doesn't clearly need a UX vs UI specialist",
  },
  {
    slug: "ux_designer",
    displayName: "UX Designer",
    category: "Design",
    purpose:
      "User flows, wireframes, information architecture, interaction patterns and journey mapping",
  },
  {
    slug: "ui_designer",
    displayName: "UI Designer",
    category: "Design",
    purpose:
      "Visual design, component specs, typography and color systems, high-fidelity mocks ready for hand-off",
  },
  {
    slug: "ux_researcher",
    displayName: "UX Researcher",
    category: "Design",
    purpose:
      "User interview plans, survey design, usability test scripts, synthesizing qualitative research findings",
  },
  {
    slug: "product_designer",
    displayName: "Product Designer",
    category: "Design",
    purpose:
      "End-to-end product design spanning research, flows, and visuals for a single feature or surface",
  },

  // ─── Go-to-Market ────────────────────────────────────────────────────
  {
    slug: "sales_account_executive",
    displayName: "Sales AE",
    category: "Go-to-Market",
    purpose:
      "Outbound prospecting messages, discovery call prep, deal-stage notes, proposal and pricing drafts",
  },
  {
    slug: "solutions_engineer",
    displayName: "Solutions Engineer",
    category: "Go-to-Market",
    purpose:
      "Customer-facing demos, technical proof-of-concepts, integration scoping for a specific prospect's stack",
  },
  {
    slug: "customer_success_manager",
    displayName: "Customer Success",
    category: "Go-to-Market",
    purpose:
      "Renewal-risk reviews, QBR decks, expansion playbooks, escalation triage for existing accounts",
  },
  {
    slug: "implementation_specialist",
    displayName: "Implementation Specialist",
    category: "Go-to-Market",
    purpose:
      "Onboards a new customer: data import plans, configuration walkthroughs, kickoff checklists, go-live readiness",
  },
  {
    slug: "technical_support_engineer",
    displayName: "Support Engineer",
    category: "Go-to-Market",
    purpose:
      "Triages customer-reported bugs, reproduces issues, files engineering tickets, drafts knowledge-base answers",
  },
  {
    slug: "marketing_manager",
    displayName: "Marketing Manager",
    category: "Go-to-Market",
    purpose:
      "Launch plans, positioning briefs, campaign messaging, blog and landing-page copy aligned to a release",
  },

  // ─── Operations ──────────────────────────────────────────────────────
  {
    slug: "project_program_manager",
    displayName: "Project / Program Manager",
    category: "Operations",
    purpose:
      "Cross-team coordination, dependency tracking, status reports, milestone planning for multi-squad efforts",
  },
  {
    slug: "scrum_master",
    displayName: "Scrum Master",
    category: "Operations",
    purpose:
      "Facilitates ceremonies, removes process blockers, coaches the team on agile practices and team health",
  },
  {
    slug: "business_analyst",
    displayName: "Business Analyst",
    category: "Operations",
    purpose:
      "Captures business requirements, process maps, gap analyses bridging operations and engineering work",
  },
  {
    slug: "it_admin",
    displayName: "IT Admin",
    category: "Operations",
    purpose:
      "Internal IT — SSO and SaaS access, employee provisioning, device policy, helpdesk-style internal tickets",
  },

  // ─── Platform ────────────────────────────────────────────────────────
  // The M4-era original operational roles + the M5b project scaffolder.
  // These keep the engine itself running rather than building a feature.
  {
    slug: "devops",
    displayName: "DevOps",
    category: "Platform",
    purpose:
      "CI/CD pipelines, build and deploy automation, Docker/Kubernetes config, release engineering scripts",
  },
  {
    slug: "techwriter",
    displayName: "Tech Writer",
    category: "Platform",
    purpose:
      "Developer docs, README and CHANGELOG updates, API reference, migration guides for engineering changes",
  },
  {
    slug: "project_scaffolder",
    displayName: "Project Scaffolder",
    category: "Platform",
    purpose:
      "Auto-files initial setup tickets when a new project is created — repo init, env scaffolding, baseline CI",
  },
];

/**
 * Grouped helper for the RoleSelect combobox sections. Preserves the order of
 * categories as declared in `ROLE_CATALOG` (no re-sorting) so the UI matches
 * this file's narrative grouping.
 */
export function groupCatalogByCategory(): Array<{
  category: string;
  entries: RoleCatalogEntry[];
}> {
  const order: string[] = [];
  const byCategory = new Map<string, RoleCatalogEntry[]>();
  for (const entry of ROLE_CATALOG) {
    if (!byCategory.has(entry.category)) {
      order.push(entry.category);
      byCategory.set(entry.category, []);
    }
    byCategory.get(entry.category)!.push(entry);
  }
  return order.map((category) => ({
    category,
    entries: byCategory.get(category)!,
  }));
}

// ─── Invariant guard ────────────────────────────────────────────────────
// Fails fast in dev / on import if anyone adds a slug to ROLES without giving
// it a catalog entry (or vice versa). Cheap — runs once at module load.
{
  const catalogSlugs = new Set(ROLE_CATALOG.map((e) => e.slug));
  const roleSlugs = Object.keys(ROLES);
  const missingFromCatalog = roleSlugs.filter((s) => !catalogSlugs.has(s));
  const extraInCatalog = ROLE_CATALOG.filter((e) => !roleSlugs.includes(e.slug)).map((e) => e.slug);
  if (missingFromCatalog.length > 0 || extraInCatalog.length > 0) {
    // Use console.error rather than throwing so importing this file in
    // type-check / pre-render contexts doesn't crash the whole app — but the
    // operator sees a loud line in the logs and the M5g UI will look broken
    // until they fix it.
    console.error(
      "[role-catalog] drift detected vs ROLES map — " +
        (missingFromCatalog.length > 0
          ? `missing catalog entries for: ${missingFromCatalog.join(", ")}. `
          : "") +
        (extraInCatalog.length > 0
          ? `catalog has unknown slugs: ${extraInCatalog.join(", ")}.`
          : ""),
    );
  }
}
