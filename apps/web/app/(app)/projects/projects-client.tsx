"use client";

// Phase 2 / M5a — Projects index client component.
//
// Layout: header with title + "New project" CTA on the right, then a grid of
// project cards. Each card surfaces the bits the operator most often wants to
// confirm at a glance: name (linked to the detail page), description (a short
// truncation; the full body lives on the detail page), the github.com URL
// (linkable in a new tab so they don't lose their place), and the relative
// created-at. Empty state is opinionated: it points at the connect flow
// rather than dumping a blank canvas.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, FolderGit2, GitBranch, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { relativeTime } from "@/lib/relative-time";

export type ProjectCardData = {
  id: string;
  name: string;
  description: string | null;
  repoUrl: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  defaultBranch: string;
  createdAt: string;
};

const DESCRIPTION_TRUNCATE = 140;

export function ProjectsClient({ initial }: { initial: ProjectCardData[] }) {
  const router = useRouter();

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="bg-muted text-muted-foreground flex h-8 w-8 items-center justify-center rounded-md">
              <FolderGit2 className="h-4 w-4" />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight">Projects</h1>
          </div>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Each project is a GitHub repo your agents work in. Connect an existing repo or create a
            fresh one — DevPilot drops a scaffolded seed commit on a feature branch and waits for
            your review before pushing.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => router.push("/projects/new")}>
          <Plus className="h-3.5 w-3.5" />
          New project
        </Button>
      </header>

      {initial.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {initial.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="bg-muted/20 flex flex-col items-center gap-3 border-dashed px-6 py-16 text-center">
      <div className="bg-muted text-muted-foreground flex h-12 w-12 items-center justify-center rounded-full">
        <FolderGit2 className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm font-medium">No projects yet</p>
        <p className="text-muted-foreground mt-1 max-w-sm text-xs">
          Connect your first GitHub repo to get started. Agents will commit on a feature branch and
          wait for your review before pushing.
        </p>
      </div>
      <Button asChild variant="primary" size="sm" className="mt-2">
        <Link href="/projects/new">
          <Plus className="h-3.5 w-3.5" />
          Connect a repo
        </Link>
      </Button>
    </Card>
  );
}

function ProjectCard({ project }: { project: ProjectCardData }) {
  const truncated =
    project.description && project.description.length > DESCRIPTION_TRUNCATE
      ? project.description.slice(0, DESCRIPTION_TRUNCATE).trimEnd() + "…"
      : project.description;

  // The persisted repo_url has a trailing `.git` — fine for a clone, but a
  // browser-clickable link should drop it so GitHub renders the repo page.
  const browserUrl = project.repoUrl ? project.repoUrl.replace(/\.git$/, "") : null;
  const ownerRepoLabel =
    project.githubOwner && project.githubRepo
      ? `${project.githubOwner}/${project.githubRepo}`
      : browserUrl
        ? browserUrl.replace(/^https?:\/\/github\.com\//, "")
        : "no repo";

  return (
    <Card className="hover:border-border/80 flex h-full flex-col transition-colors">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm">
            <Link
              href={`/projects/${project.id}`}
              className="hover:underline hover:underline-offset-2"
            >
              {project.name}
            </Link>
          </CardTitle>
          <Badge tone="muted" className="font-mono text-[10px]">
            <GitBranch className="h-3 w-3" />
            {project.defaultBranch}
          </Badge>
        </div>
        <CardDescription className="line-clamp-2 text-xs">
          {truncated ?? <span className="text-muted-foreground italic">No description.</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 pt-0">
        {browserUrl ? (
          <a
            href={browserUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-muted-foreground hover:text-foreground group inline-flex items-center gap-1 text-xs"
          >
            <code className="font-mono">{ownerRepoLabel}</code>
            <ExternalLink className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </a>
        ) : (
          <span className="text-muted-foreground text-xs italic">Repo not linked yet</span>
        )}
      </CardContent>
      <CardFooter className="justify-between border-t pt-3 text-[11px]">
        <span>Created {relativeTime(project.createdAt)}</span>
        <Link
          href={`/projects/${project.id}`}
          className="text-foreground hover:underline hover:underline-offset-2"
        >
          Open →
        </Link>
      </CardFooter>
    </Card>
  );
}
