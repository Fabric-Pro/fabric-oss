/**
 * GitLab PM adapter — moved to @repo/integrations/gitlab/pm-adapter so both
 * API procedures and Temporal activities (which can't depend on @repo/api)
 * can use the same dispatch.
 *
 * This file is kept as a thin re-export so existing import paths in
 * `import-from-pm.ts`, `list-pm-tickets.ts`, and the procedure tests
 * continue to resolve unchanged.
 */
export * from "@repo/integrations/gitlab/pm-adapter";
