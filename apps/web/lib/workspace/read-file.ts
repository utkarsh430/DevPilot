// Phase 2 / M5e — Compatibility re-export for the workspace file reader.
//
// The plan enumerates both `lib/workspace/list.ts` (tree builder) and
// `lib/workspace/read-file.ts` (capped reader) as separate files. The
// implementation keeps both helpers in `list.ts` because the path-traversal
// guard + size cap logic is tightly coupled to the tree builder's view of
// "workspace root". This module re-exports `readWorkspaceFile` so existing
// import paths (`@/lib/workspace/read-file`) keep working.

export { readWorkspaceFile } from "./list";
