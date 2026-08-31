/**
 * Deterministic answer → Clean Spec write (Feature Maturation V2, notebook model).
 *
 * Replaces the per-answer LLM scoped-patch (`propagate-decision-to-spec.ts`, now
 * dormant). When the PO answers a question, the Q+A is recorded — without any
 * model call — into a transient `## Resolved Decisions (pending integration)`
 * appendix at the END of `description`. The NEXT maturation run reads it (the AI
 * sees only the spec), dissolves each decision into the right body section (or
 * the `## Out of Scope / Constraints` section for non-goals), and removes the
 * appendix — see `getPendingDecisionsIntegrationClause`.
 *
 * Why no PM sync here: the appendix is transient scaffolding, not a dev-facing
 * change. The next enhance enqueues PM sync with the clean integrated result, so
 * PM never sees the scaffolding. The write itself goes through the shared story
 * update path and DOES snapshot: it changes `description`, so `updateStory`
 * takes its version branch — the story's `version` increments and a
 * `FeatureVersion` row capturing the PRE-answer body is written. That is
 * deliberate; it is what makes an answer's effect on the spec revertible, and it
 * is also the compare-and-set token the concurrency guard below relies on.
 */

import {
	getPendingDecisionsIntegrationClause,
	PENDING_DECISIONS_HEADING,
} from "@repo/agent-prompts";
import {
	type MaturationTenantFilter,
	updateStoryDescriptionUnderLock,
} from "@repo/database";
import { findHeadingLineEnd } from "@repo/utils/markdown-heading";

// The heading and the integration clause now live in `@repo/agent-prompts` so the
// langgraph agent prompt builder and the API enhance path read identical wording
// (the "cannot drift" contract). Re-exported here so existing importers
// (enhance-feature.ts) keep a single import site.
export { getPendingDecisionsIntegrationClause, PENDING_DECISIONS_HEADING };

/**
 * Offset just PAST the appendix's heading line, or `-1` when the document has
 * no appendix.
 *
 * The decoration-tolerant scan lives in `@repo/utils/markdown-heading` because
 * the client path that has to splice the same appendix back into a document
 * needs it too, and this module imports `@repo/database` so it cannot be the
 * shared home. See `findHeadingLineEnd` for why the raw `indexOf` it replaces
 * was not enough and why the offset is measured against the ORIGINAL text.
 */
function findPendingDecisionsHeadingEnd(text: string): number {
	return findHeadingLineEnd(text, PENDING_DECISIONS_HEADING);
}

/**
 * Append a resolved Q+A to the pending-decisions appendix. The appendix lives at
 * the end of `description`; if it already exists (always the last section, since
 * we only ever append and the enhance run prunes it), the bullet is appended at
 * the end. Pure — returns the new description.
 */
export function appendPendingDecision(
	description: string | null | undefined,
	question: string,
	answer: string,
): string {
	const bullet = `- **Q:** ${question.trim()}\n  **Decided:** ${answer.trim()}`;
	const base = (description ?? "").trimEnd();
	if (!base) {
		return `${PENDING_DECISIONS_HEADING}\n\n${bullet}`;
	}
	if (findPendingDecisionsHeadingEnd(base) !== -1) {
		return `${base}\n${bullet}`;
	}
	return `${base}\n\n${PENDING_DECISIONS_HEADING}\n\n${bullet}`;
}

/**
 * Count the decisions sitting in the pending-decisions appendix — i.e. answers
 * recorded but not yet merged into the Clean Spec body. Drives the "X New
 * Decisions" indicator (#B): answering appends a `**Q:**` bullet (count up), and
 * a Clean Spec refresh dissolves the whole appendix (count back to 0). Pure parse
 * of `description`; the appendix is always the last section. Returns 0 when no
 * appendix is present.
 */
export function countPendingDecisions(
	description: string | null | undefined,
): number {
	const text = description ?? "";
	const headingEnd = findPendingDecisionsHeadingEnd(text);
	if (headingEnd === -1) {
		return 0;
	}
	const after = text.slice(headingEnd);
	// Defensive: stop at a following H2 even though the appendix is the last section.
	// NOT normalized: `/\n##\s/` only needs whitespace after the hashes, which a
	// decorated following heading (`## <mark>…`) already satisfies.
	const nextHeading = after.search(/\n##\s/);
	const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
	const bullets = section.match(/(?:^|\n)\s*-\s+\*\*Q:\*\*/g);
	return bullets ? bullets.length : 0;
}

export interface RecordAnswerInSpecParams {
	storyId: string;
	projectId: string;
	tenantFilter: MaturationTenantFilter;
	lastEditedByName?: string | null;
	question: string;
	answer: string;
}

/**
 * Persist a resolved Q+A into the Clean Spec's pending-decisions appendix. No
 * model call, no PM sync. It DOES write a `FeatureVersion` snapshot of the
 * pre-answer body and bump the story version, because the write changes
 * `description` and the shared `updateStory` path snapshots whenever it does.
 *
 * There is deliberately NO `currentDescription` parameter. The caller must not
 * hand in a base text it read earlier: two answers submitted seconds apart would
 * both append to the same stale base and the later write would drop the earlier
 * bullet. `updateStoryDescriptionUnderLock` re-reads the row's description
 * inside the write's own transaction and under its `FOR UPDATE` lock, so the
 * second answer computes its bullet against the first one's committed result.
 */
/**
 * Upsert a resolved Q+A into the pending-decisions appendix (#1910).
 *
 * Amending an answer MUST NOT append a second bullet for the same question. The
 * appendix is part of `description`, and the Clean Spec is the only thing the AI
 * reads — two bullets answering one question differently would hand the next
 * maturation run two contradictory decisions with no way to tell which is
 * current. So an existing bullet for this question is REPLACED in place,
 * preserving its position in the appendix.
 *
 * Falls back to a plain append when there is no matching bullet, which is the
 * normal case after a maturation run has dissolved the appendix into the body.
 * The body then still states the superseded answer while this bullet carries the
 * correction — which is exactly what the appendix is for: telling the next run
 * what changed.
 *
 * Matching is a literal `indexOf` on the question line, never a regex, so
 * question text containing regex metacharacters cannot misbehave. Pure.
 */
export function upsertPendingDecision(
	description: string | null | undefined,
	question: string,
	answer: string,
): string {
	const base = (description ?? "").trimEnd();
	const headingEnd = findPendingDecisionsHeadingEnd(base);
	if (headingEnd === -1) {
		return appendPendingDecision(base, question, answer);
	}

	const head = base.slice(0, headingEnd);
	const body = base.slice(headingEnd);
	const marker = `- **Q:** ${question.trim()}`;
	const found = body.indexOf(`\n${marker}`);
	if (found === -1) {
		return appendPendingDecision(base, question, answer);
	}

	// Replace from the start of the matched bullet up to the next bullet (or the
	// end), so a multi-line "Decided:" block is fully swapped rather than leaving
	// orphaned continuation lines behind.
	const from = found + 1;
	const nextBullet = body.indexOf("\n- **Q:** ", from + marker.length);
	const to = nextBullet === -1 ? body.length : nextBullet;
	const bullet = `- **Q:** ${question.trim()}\n  **Decided:** ${answer.trim()}`;
	return `${head}${body.slice(0, from)}${bullet}${body.slice(to)}`;
}

/**
 * Amend a previously recorded answer in the Clean Spec (#1910). Same write path
 * and concurrency guard as `recordAnswerInSpec`, but upserts the question's
 * bullet instead of appending, so the spec carries exactly one current answer.
 */
export async function amendAnswerInSpec({
	storyId,
	projectId,
	tenantFilter,
	lastEditedByName,
	question,
	answer,
}: RecordAnswerInSpecParams): Promise<void> {
	await updateStoryDescriptionUnderLock(
		storyId,
		projectId,
		(currentDescription) =>
			upsertPendingDecision(currentDescription, question, answer),
		{
			userId: tenantFilter.userId,
			organizationId: tenantFilter.organizationId ?? undefined,
			changedBy: tenantFilter.userId,
			lastEditedByName: lastEditedByName ?? null,
			lastEditedSource: "MANUAL",
		},
	);
}

export async function recordAnswerInSpec({
	storyId,
	projectId,
	tenantFilter,
	lastEditedByName,
	question,
	answer,
}: RecordAnswerInSpecParams): Promise<void> {
	await updateStoryDescriptionUnderLock(
		storyId,
		projectId,
		(currentDescription) =>
			appendPendingDecision(currentDescription, question, answer),
		{
			userId: tenantFilter.userId,
			organizationId: tenantFilter.organizationId ?? undefined,
			changedBy: tenantFilter.userId,
			lastEditedByName: lastEditedByName ?? null,
			lastEditedSource: "MANUAL",
		},
	);
}
