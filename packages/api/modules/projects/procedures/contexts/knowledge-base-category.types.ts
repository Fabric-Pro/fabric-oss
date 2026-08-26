/**
 * The Knowledge Base Source Category values (Fizzy #2165).
 *
 * Deliberately import-free so a client component can use the list without
 * pulling a server module into the browser bundle — the same reason
 * `list-pm-tickets-filters.types.ts` sits beside its procedure. The zod schema
 * and the server-side validation live in `knowledge-base-category.ts`, which
 * imports `@orpc/server` and must never be reached from `apps/web`.
 *
 * Declaration order is the display order the acceptance criteria specify, so
 * anything rendering the options can iterate this rather than restating it.
 */
export const KNOWLEDGE_BASE_SOURCE_CATEGORIES = [
	"KNOWLEDGE_BASE_WIKI",
	"PRODUCT_DOCUMENTATION",
	"TECHNICAL_DEVELOPER_DOCUMENTATION",
	"API_DOCUMENTATION",
	"HELP_CENTER_SUPPORT_DOCS",
	"MARKETING_WEBSITE",
	"COMPLIANCE_SECURITY_DOCUMENTATION",
	"OTHER",
] as const;

export type KnowledgeBaseSourceCategoryValue =
	(typeof KNOWLEDGE_BASE_SOURCE_CATEGORIES)[number];
