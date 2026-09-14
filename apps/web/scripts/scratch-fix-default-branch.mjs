// One-off: reset Japanese Website Revamp project's default_branch to 'main'
// AND cross-check what GitHub reports as the repo's actual default branch.
// Surfaces any mismatch so the operator can fix it on github.com if needed.
//
// Scratch script — safe to delete after the cleanup runs.
//
// Run: node --env-file=apps/web/.env.local apps/web/scripts/scratch-fix-default-branch.mjs

import { Client } from "pg";

const PROJECT_ID = "8794f295-8f1f-4e05-8895-05b016593b5b";
const NEW_DEFAULT_BRANCH = "main";

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

try {
  // 1. Snapshot current state.
  const before = await client.query(
    `select id, name, default_branch, integration_branch, repo_url,
            github_owner, github_repo, github_repo_id, created_by
       from public.projects
      where id = $1`,
    [PROJECT_ID],
  );
  if (before.rowCount === 0) {
    console.error(`project ${PROJECT_ID} not found`);
    process.exit(2);
  }
  const proj = before.rows[0];
  console.log("=== before ===");
  console.log({
    name: proj.name,
    default_branch: proj.default_branch,
    integration_branch: proj.integration_branch,
    github: `${proj.github_owner}/${proj.github_repo}`,
  });

  // 2. UPDATE.
  await client
    .query(`update public.projects set default_branch = $1, updated_at = now() where id = $2`, [
      NEW_DEFAULT_BRANCH,
      PROJECT_ID,
    ])
    .catch(async (err) => {
      // updated_at column might not exist on projects; retry without it.
      if (/column.*updated_at.*does not exist/.test(err.message)) {
        await client.query(`update public.projects set default_branch = $1 where id = $2`, [
          NEW_DEFAULT_BRANCH,
          PROJECT_ID,
        ]);
      } else {
        throw err;
      }
    });
  console.log(`default_branch updated → ${NEW_DEFAULT_BRANCH}`);

  // 3. Cross-check with GitHub. Use the project owner's OAuth token (the
  //    same one the runner uses to push). If we can't resolve a token,
  //    skip — the operator can verify on github.com themselves.
  if (!proj.github_owner || !proj.github_repo || !proj.created_by) {
    console.log("\n(GitHub cross-check skipped: missing owner/repo/created_by)");
    process.exit(0);
  }

  const { ensureFreshGithubToken } = await import("../lib/github/refresh.js").catch(() => ({
    ensureFreshGithubToken: null,
  }));
  if (!ensureFreshGithubToken) {
    console.log("\n(GitHub cross-check skipped: refresh module not importable from script)");
    process.exit(0);
  }
  const token = await ensureFreshGithubToken(proj.created_by).catch(() => null);
  if (!token) {
    console.log("\n(GitHub cross-check skipped: no token for project owner)");
    process.exit(0);
  }
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(proj.github_owner)}/${encodeURIComponent(proj.github_repo)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devpilot-scratch",
      },
    },
  );
  if (!res.ok) {
    console.log(`\n(GitHub cross-check failed: ${res.status} ${res.statusText})`);
    process.exit(0);
  }
  const repo = await res.json();
  const githubDefault = repo.default_branch;
  console.log("\n=== GitHub says ===");
  console.log({ default_branch: githubDefault });

  if (githubDefault !== NEW_DEFAULT_BRANCH) {
    console.log(
      `\n⚠️  MISMATCH: DevPilot now has default_branch='${NEW_DEFAULT_BRANCH}' but ` +
        `GitHub reports '${githubDefault}'. Either fix it on github.com ` +
        `(Settings → Branches → Default branch) or re-run this script with ` +
        `NEW_DEFAULT_BRANCH='${githubDefault}'.`,
    );
  } else {
    console.log("\n✓ DevPilot and GitHub agree on default_branch.");
  }
} catch (err) {
  console.error("fix failed:", err.message);
  process.exit(1);
} finally {
  await client.end();
}
