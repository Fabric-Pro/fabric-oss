/**
 * Shared, pure constants and helpers for the AI drafting run — the durable
 * background job behind "Generate test cases with AI". No React here so the
 * dialog, the watcher and the results sheet can all share it without a component
 * import cycle. Mirrors the structure of this module's `constants.ts`.
 */

/**
 * How many features one run may draft from.
 *
 * Mirrors `MAX_FEATURES_PER_DRAFT_JOB` in
 * `packages/api/modules/projects/procedures/test-cases/ai-draft-test-cases.ts`,
 * which is the enforcing copy — the server rejects an over-long request rather
 * than trimming it. Duplicated here because the browser cannot import @repo/api
 * (it would pull Prisma into the bundle), following the same convention as the
 * enum literals in `constants.ts`.
 *
 * The number is a spend limit: each feature is a separate LLM generation, so
 * this is the ceiling on what one click can bill.
 */
export const MAX_FEATURES_PER_DRAFT_JOB = 5;

/** Lifecycle of a drafting run (Prisma `TestCaseDraftJobStatus`). */
type TestCaseDraftJobStatus =
	| "PENDING"
	| "RUNNING"
	| "SUCCEEDED"
	| "FAILED"
	| "CANCELLED";

/** Why one requested feature did or didn't produce cases. */
export type TestCaseDraftFeatureOutcomeStatus =
	| "DRAFTED"
	| "NO_ACCEPTANCE_CRITERIA"
	| "NO_AI_PROVIDER"
	| "NO_CASES"
	| "NOT_FOUND"
	| "FAILED";

/** A run that has not reached a terminal state yet. */
const ACTIVE_DRAFT_JOB_STATUSES: TestCaseDraftJobStatus[] = [
	"PENDING",
	"RUNNING",
];

export function isDraftJobActive(status: string): boolean {
	return ACTIVE_DRAFT_JOB_STATUSES.some((active) => active === status);
}

/**
 * The i18n key for a feature-outcome status, under
 * `projects.testCases.ai.outcomes`.
 */
export function draftOutcomeMessageKey(
	status: TestCaseDraftFeatureOutcomeStatus,
): string {
	switch (status) {
		case "DRAFTED":
			return "drafted";
		case "NO_ACCEPTANCE_CRITERIA":
			return "noAcceptanceCriteria";
		case "NO_AI_PROVIDER":
			return "noAiProvider";
		case "NO_CASES":
			return "noCases";
		case "NOT_FOUND":
			return "notFound";
		case "FAILED":
			return "failed";
		default: {
			// A new outcome status must be given copy here rather than silently
			// rendering a raw enum value at the user.
			const exhaustive: never = status;
			return exhaustive;
		}
	}
}

/**
 * Whether this project role may edit test cases.
 *
 * The same predicate `ProjectDetails` applies when it decides whether to hand
 * `canEdit` to the cases list. It lives here because the drafting results view is
 * reachable from a notification deep link — i.e. rendered without the list's
 * props — and must not show edit affordances to a reader who lost the role since
 * starting the run. Every mutation is server-gated regardless; this only governs
 * what is offered.
 */
export function canEditTestCases(userRole: string | null | undefined): boolean {
	return (
		!!userRole &&
		["owner", "editor", "admin", "project_admin", "PROJECT_ADMIN"].includes(
			userRole,
		)
	);
}
