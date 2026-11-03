/**
 * Catalog key the GitHub Projects PM option carries
 * (`packages/database/prisma/default-pm-tool-keys.ts`). PM sync for it never
 * uses an MCPConfig: boards and items go through the GitHub connection.
 */
export const GITHUB_PROJECTS_KEY = "github-remote";
