// Phase 2 / M5a — Projects index page.
//
// Server component: auth-gates, loads the tenant's projects via the
// service-role helper, and hands them to <ProjectsClient /> for rendering +
// row interactions. Empty state nudges the operator toward the connect flow.

import { requireTenantId, requireUser } from "@/lib/auth";
import { loadProjectsForTenant } from "@/lib/projects/load";
import { ProjectsClient, type ProjectCardData } from "./projects-client";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  await requireUser();
  const tenantId = await requireTenantId();

  const projects = await loadProjectsForTenant(tenantId);

  // Map to the client-side shape. We strip the tenantId / createdBy fields
  // because they're not meaningful to the UI and reducing the JSON payload
  // keeps the initial RSC stream tight.
  const initial: ProjectCardData[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    repoUrl: p.repoUrl,
    githubOwner: p.githubOwner,
    githubRepo: p.githubRepo,
    defaultBranch: p.defaultBranch,
    createdAt: p.createdAt,
  }));

  return <ProjectsClient initial={initial} />;
}
