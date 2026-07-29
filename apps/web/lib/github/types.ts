// Shared GitHub-token / profile types consumed by oauth.ts, refresh.ts,
// the engine's per-job lookup (A4), the GitHub REST client (A3), and the
// /settings/github-integration UI (A6).
//
// CLAUDE.md §6 ("Untrusted content rule") means the access_token field is
// only ever surfaced from `getGithubAccessToken()` / `ensureFreshGithubToken()`.
// Status/UI callers go through `getGithubTokenRow()` which omits the secret
// by default.

export type GithubAccessTokenRow = {
  userId: string;
  accessToken: string; // decrypted plaintext
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string;
  githubId: number;
  githubLogin: string;
};

export type GithubProfileSnippet = {
  id: number;
  login: string;
  avatarUrl: string;
  scopes: string;
};
