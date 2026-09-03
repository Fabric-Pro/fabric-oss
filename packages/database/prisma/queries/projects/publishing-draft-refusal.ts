import { logger } from "@repo/logs";
import type { DraftCommitRefusal } from "./publishing-tenant-lock";

/**
 * What a refused terminal write means, in words an operator can act on.
 *
 * Fifteen call sites refuse a terminal write on a Publishing Suite generation
 * row — five generation activities, five failure markers, and five API
 * start-procedure rollbacks — and every one of them used to report the same
 * sentence for four different causes, because all four arrived as a bare
 * `{ persisted: false }`. The sentence was "superseded", which is true of
 * exactly one of them.
 *
 * That is worse than saying nothing. "Attempt superseded" tells an operator
 * that a newer run took over, so they go looking for it; when the real cause
 * was somebody archiving the project mid-generation, there is no newer run to
 * find and the search ends in confusion rather than in an answer.
 *
 * ## Why this lives in `@repo/database` rather than beside the activities
 *
 * The refusal reasons are produced here, and BOTH consumers are downstream:
 * `@repo/temporal` runs the ten activity sites and `@repo/api` the five
 * rollbacks. Putting the table next to its type is what keeps one vocabulary
 * instead of two, and this package already depends on `@repo/logs` and logs
 * from its queries, so it costs no new dependency edge.
 *
 * `Record<DraftCommitRefusal, string>` and not a partial map: adding a reason
 * to the union without a sentence here is then a type error rather than a
 * silent fall-through.
 */
const DRAFT_REFUSAL_REASON: Record<DraftCommitRefusal, string> = {
	superseded: "a newer attempt owns this content type",
	project_ineligible:
		"the project was archived or deleted while the attempt ran",
	tenant_changed:
		"the project moved to a different organization while the attempt ran",
	attempt_missing: "the attempt row no longer exists",
};

/**
 * Log a refused terminal write at the level its cause deserves.
 *
 * The severity split is the second half of the fix. `superseded` is the
 * expected outcome of the deadline sweep and belongs at info. The other three
 * mean somebody acted on the project — or on the topic — while a generation was
 * in flight, and `tenant_changed` is not reachable by any production code path
 * today, so seeing one at all is news; burying it at info alongside routine
 * sweeps is how it would go unnoticed.
 *
 * The emit lives here rather than at the call sites so the level rule is
 * decided once. Fifteen copies of `reason === "superseded" ? info : warn` is
 * how one of them ends up inverted. It also keeps the logger call attached to
 * its own object: `const log = cond ? logger.info : logger.warn` detaches a
 * method from the consola instance, which is a question this shape never has to
 * answer.
 */
export function logDraftRefusal(
	prefix: string,
	reason: DraftCommitRefusal,
	detail: Record<string, unknown>,
): void {
	const line = `${prefix}: ${DRAFT_REFUSAL_REASON[reason]}`;
	const bag = { ...detail, reason };

	if (reason === "superseded") {
		logger.info(line, bag);
		return;
	}
	logger.warn(line, bag);
}
