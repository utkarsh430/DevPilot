import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// resolveLangfuseLinkConfig must mirror langfuseForTenant's resolution
// (tenant override » instance » env) so a Langfuse base URL / project id set
// via Settings (platform-secrets) drives the Run Inspector's trace/observation
// deep-links, not just the span-emitting client. Mock the resolver so the
// test never touches Supabase.
const platformSecretsEnabled = vi.fn<() => boolean>();
const resolveSync = vi.fn<(key: string, opts: { tenantId: string | null }) => string | undefined>();

vi.mock("@/lib/platform-secrets/resolver", () => ({
  platformSecretsEnabled: (...args: unknown[]) =>
    (platformSecretsEnabled as unknown as (...a: unknown[]) => boolean)(...args),
  resolveSync: (...args: [string, { tenantId: string | null }]) => resolveSync(...args),
  ensurePlatformSecretsLoaded: vi.fn(async () => {}),
}));

const ORIGINAL_ENV = { ...process.env };

describe("resolveLangfuseLinkConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    platformSecretsEnabled.mockReset();
    resolveSync.mockReset();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns raw env values when platform-secrets is disabled", async () => {
    process.env.LANGFUSE_BASE_URL = "https://env.example.com";
    process.env.LANGFUSE_PROJECT_ID = "env-project";
    platformSecretsEnabled.mockReturnValue(false);

    const { resolveLangfuseLinkConfig } = await import("../langfuse");
    const result = resolveLangfuseLinkConfig("tenant-1");

    expect(result).toEqual({ baseUrl: "https://env.example.com", projectId: "env-project" });
    expect(resolveSync).not.toHaveBeenCalled();
  });

  it("prefers the resolver override over env when platform-secrets is enabled", async () => {
    process.env.LANGFUSE_BASE_URL = "https://env.example.com";
    process.env.LANGFUSE_PROJECT_ID = "env-project";
    platformSecretsEnabled.mockReturnValue(true);
    resolveSync.mockImplementation((key: string) => {
      if (key === "LANGFUSE_BASE_URL") return "https://configured.example.com";
      if (key === "LANGFUSE_PROJECT_ID") return "configured-project";
      return undefined;
    });

    const { resolveLangfuseLinkConfig } = await import("../langfuse");
    const result = resolveLangfuseLinkConfig("tenant-1");

    expect(result).toEqual({
      baseUrl: "https://configured.example.com",
      projectId: "configured-project",
    });
    expect(resolveSync).toHaveBeenCalledWith("LANGFUSE_BASE_URL", { tenantId: "tenant-1" });
    expect(resolveSync).toHaveBeenCalledWith("LANGFUSE_PROJECT_ID", { tenantId: "tenant-1" });
  });

  it("falls back to env when platform-secrets is enabled but nothing resolves", async () => {
    process.env.LANGFUSE_BASE_URL = "https://env.example.com";
    process.env.LANGFUSE_PROJECT_ID = "env-project";
    platformSecretsEnabled.mockReturnValue(true);
    resolveSync.mockReturnValue(undefined);

    const { resolveLangfuseLinkConfig } = await import("../langfuse");
    const result = resolveLangfuseLinkConfig("tenant-1");

    expect(result).toEqual({ baseUrl: "https://env.example.com", projectId: "env-project" });
  });

  it("yields a blank project id (and thus a hidden trace link) when nothing is configured anywhere", async () => {
    delete process.env.LANGFUSE_PROJECT_ID;
    platformSecretsEnabled.mockReturnValue(true);
    resolveSync.mockReturnValue(undefined);

    const { resolveLangfuseLinkConfig } = await import("../langfuse");
    const { langfuseTraceUrl } = await import("../url");
    const result = resolveLangfuseLinkConfig("tenant-1");

    expect(result.projectId).toBe("");
    expect(langfuseTraceUrl(result.baseUrl, result.projectId, "run-1")).toBeNull();
  });
});
