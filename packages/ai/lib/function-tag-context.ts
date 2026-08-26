import { getFunctionTagContextClause } from "@repo/agent-prompts";
import {
	FUNCTION_TAG_LABELS,
	FUNCTION_TAG_ORDER,
	type FunctionTag,
	getProjectMemberFunctionTags,
	hasProjectAccess,
} from "@repo/database";
import { logger } from "@repo/logs";
import { isFunctionTagsEnabled } from "@repo/utils/feature-flag";

/**
 * PURE — unit-testable without a DB. Turns roster-scoped tag rows into an
 * ordered label composition + the requester's own labels. Returns null when no
 * roster member holds any tag (→ no clause). De-dupes by userId and by tag
 * within a user defensively.
 */
export function computeFunctionTagContext(
	rows: { userId: string; tags: FunctionTag[] }[],
	requesterUserId?: string,
): {
	composition: { label: string; count: number }[];
	requesterLabels: string[];
} | null {
	const byUser = new Map<string, Set<FunctionTag>>();
	for (const r of rows) {
		// Merge (union) tags across any duplicate rows for the same userId rather
		// than keeping only the first — honors the "defensive de-dupe" contract so
		// a future caller that passes multiple rows per user can't silently drop
		// tags. The Set also de-dupes tags within a user. (Today's sole caller,
		// getProjectMemberFunctionTags, already emits one row per userId, so this
		// is behavior-preserving.)
		let set = byUser.get(r.userId);
		if (!set) {
			set = new Set<FunctionTag>();
			byUser.set(r.userId, set);
		}
		for (const t of r.tags) {
			set.add(t);
		}
	}
	const counts = new Map<FunctionTag, number>();
	for (const tags of byUser.values()) {
		for (const t of tags) {
			counts.set(t, (counts.get(t) ?? 0) + 1);
		}
	}
	if (counts.size === 0) {
		return null;
	}

	const composition = FUNCTION_TAG_ORDER.filter((t) => counts.has(t)).map(
		(t) => ({
			label: FUNCTION_TAG_LABELS[t],
			count: counts.get(t) as number,
		}),
	);

	const requesterTags = requesterUserId
		? byUser.get(requesterUserId)
		: undefined;
	const requesterLabels = requesterTags
		? FUNCTION_TAG_ORDER.filter((t) => requesterTags.has(t)).map(
				(t) => FUNCTION_TAG_LABELS[t],
			)
		: [];

	return { composition, requesterLabels };
}

/**
 * Server-only convenience: flag → point-of-use authorization → roster-scoped
 * resolve → render. Returns "" when disabled / unauthorized / no tags / on error
 * (fail-open). Callers append the value verbatim, ONLY when non-empty.
 */
export async function getProjectFunctionTagClause(args: {
	projectId: string;
	requesterUserId: string;
	surface: string;
}): Promise<string> {
	if (!isFunctionTagsEnabled()) {
		return "";
	}
	try {
		// Point-of-use authorization: requester must currently have project access.
		// Closes the membership-removal TOCTOU on shared cores also reached by
		// scheduled paths (Living Docs refresh → update-with-context-core).
		//
		// This access check and the roster read below are intentionally NOT wrapped
		// in a single transaction — a residual micro-window remains where a member
		// removed between the two reads could still have their role reflected in the
		// clause. Accepted by design: (1) the exposed data is aggregate role
		// composition used only for tone calibration, never a secret; (2) the
		// unavoidable seconds-long LLM-generation window that follows dominates the
		// microsecond DB gap, so DB-level atomicity would not meaningfully narrow the
		// exposure; (3) this mirrors the already-shipped `listForProject` read, which
		// is likewise non-transactional.
		if (!(await hasProjectAccess(args.projectId, args.requesterUserId))) {
			return "";
		}

		const rosterTags = await getProjectMemberFunctionTags(args.projectId);
		const ctx = computeFunctionTagContext(rosterTags, args.requesterUserId);
		if (!ctx) {
			return "";
		}

		logger.info("function-tag AI context injected", {
			surface: args.surface,
			projectId: args.projectId,
			tagCount: ctx.composition.reduce((n, c) => n + c.count, 0),
		});
		return getFunctionTagContextClause(ctx);
	} catch (err) {
		logger.warn("function-tag AI context resolution failed; skipping", {
			surface: args.surface,
			projectId: args.projectId,
			err,
		});
		return "";
	}
}
