// Shared types for the skill marketplace (Phase 1 / M11).

export type SkillManifest = {
  summary?: string;
  author?: string;
  verified?: boolean;
  [key: string]: unknown;
};

export type SkillRow = {
  id: string;
  tenant_id: string | null;
  name: string;
  version: string;
  manifest: SkillManifest;
  body: string;
  targets: string[];
  triggers: string[];
  installed_from_skill_id: string | null;
  created_at: string;
};

export type ToolPackageManifest = {
  summary?: string;
  author?: string;
  verified?: boolean;
  mcp_server_url?: string;
  auth_ref?: string;
  tools?: string[];
  [key: string]: unknown;
};

export type ToolPackageRow = {
  id: string;
  tenant_id: string | null;
  name: string;
  version: string;
  manifest: ToolPackageManifest;
  body: string;
  installed_from_tool_package_id: string | null;
  created_at: string;
};
