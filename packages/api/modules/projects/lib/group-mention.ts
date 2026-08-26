/**
 * Group-mention resolution (#1767 Stage 5). Expands a function-tag group to
 * its current project tag-holders and re-narrows recipients to the current
 * project roster immediately before dispatch. Flag-gated and fail-open — a
 * resolution failure must never break the comment/document write.
 */

import {
	db,
	type FunctionTag,
	getProjectMemberFunctionTags,
	membersHoldingTags,
} from "@repo/database";
import { logger } from "@repo/logs";
import { isFunctionTagsEnabled } from "@repo/utils/feature-flag";

/**
 * Batch group-mention resolution. Reads the project roster ONCE and returns
 * the current tag-holders for EACH requested tag, so a comment/document that
 * mentions several groups no longer re-reads the roster per tag (the old
 * single-tag helper did — bounded by the tag count, but redundant). Flag-gated
 * and fail-open: any failure (or the flag being off) yields an empty map so
 * the write is never broken. Callers take the union of the map's values,
 * narrow it ONCE via `narrowToCurrentProjectRoster`, then fan out per tag in
 * `FUNCTION_TAG_ORDER` — the narrow is a membership filter, so per-tag holders
 * intersected with the narrowed union equal the per-tag narrow (the recipients
 * of the removed per-tag path, preserved on the success path).
 *
 * Trade-off vs. the removed per-tag helper: because the roster is read ONCE, a
 * transient read failure now drops group notifications for the whole save
 * (all-or-nothing) instead of the per-tag path's incidental partial delivery
 * (each tag re-read the roster, so a later read could still succeed). Accepted:
 * this path is advisory, flag-gated, and fire-and-forget with no retry in
 * either version, and all-or-nothing is more consistent than a silent partial.
 */
export async function expandGroupMentionsByTag(args: {
	projectId: string;
	groupTags: FunctionTag[];
}): Promise<Map<FunctionTag, string[]>> {
	const empty = new Map<FunctionTag, string[]>();
	if (!isFunctionTagsEnabled()) {
		return empty;
	}
	if (args.groupTags.length === 0) {
		return empty;
	}
	try {
		const roster = await getProjectMemberFunctionTags(args.projectId);
		const byTag = new Map<FunctionTag, string[]>();
		for (const tag of args.groupTags) {
			byTag.set(tag, membersHoldingTags(roster, [tag]));
		}
		return byTag;
	} catch (error) {
		logger.warn(
			{ err: error, projectId: args.projectId },
			"[group-mention] expandGroupMentionsByTag failed — returning no recipients",
		);
		return empty;
	}
}

/**
 * Project-scoped final recipient narrow. Keeps only the
 * project owner or an accepted, unexpired ProjectMember — stricter than the
 * org-soft `filterAuthorizedMentionRecipients`. Preserves input order.
 */
export async function narrowToCurrentProjectRoster(
	userIds: string[],
	projectId: string,
): Promise<string[]> {
	if (userIds.length === 0) {
		return [];
	}
	const [project, members] = await Promise.all([
		db.project.findUnique({
			where: { id: projectId },
			select: { userId: true },
		}),
		db.projectMember.findMany({
			where: {
				projectId,
				userId: { in: userIds },
				acceptedAt: { not: null },
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
			select: { userId: true },
		}),
	]);
	const allowed = new Set(members.map((m) => m.userId));
	if (project && userIds.includes(project.userId)) {
		allowed.add(project.userId);
	}
	return userIds.filter((id) => allowed.has(id));
}
