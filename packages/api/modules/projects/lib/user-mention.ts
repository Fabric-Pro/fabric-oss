/**
 * Parser for `@username` mentions targeting human team members.
 *
 * Distinct from `@fabric` (the AI assistant), which is reserved and handled
 * by `fabric-mention.ts`. The regex below explicitly excludes the literal
 * `fabric` to keep the two paths from overlapping.
 */

import type { FunctionTag } from "@repo/database";
import { db } from "@repo/database";
import { GROUP_SLUG_TO_TAG } from "@repo/database/src/function-tags";

const USERNAME_PATTERN = /(^|\s)@([a-z0-9_-]{2,32})(?=$|\s|[:,.!?])/gi;
const RESERVED_USERNAMES = new Set(["fabric"]);

/**
 * Extract distinct lowercased usernames mentioned in `content`. Returns
 * an empty array when no mentions or only reserved tokens are present.
 *
 * - Matches must be at a word boundary (start of string or whitespace)
 *   followed by `@` and a username 2–32 chars long.
 * - Reserved names like `fabric` are filtered out.
 * - Duplicates are collapsed to a single entry.
 */
export function extractUserMentions(content: string): string[] {
	if (!content) {
		return [];
	}
	const seen = new Set<string>();
	const matches = content.matchAll(USERNAME_PATTERN);
	for (const match of matches) {
		const username = match[2]?.toLowerCase();
		if (!username) {
			continue;
		}
		if (RESERVED_USERNAMES.has(username)) {
			continue;
		}
		seen.add(username);
	}
	return Array.from(seen);
}

/**
 * Filter user IDs to those who are part of a project's collaboration
 * surface (host-org member or accepted project member). Soft narrowing —
 * read-time access checks still apply.
 */
export async function filterAuthorizedMentionRecipients(
	userIds: string[],
	projectId: string,
	organizationId: string | null,
): Promise<string[]> {
	if (userIds.length === 0) {
		return [];
	}

	const allowed = new Set<string>();

	if (organizationId) {
		const orgMembers = await db.member.findMany({
			where: {
				organizationId,
				userId: { in: userIds },
			},
			select: { userId: true },
		});
		for (const m of orgMembers) {
			allowed.add(m.userId);
		}
	}

	const projectMembers = await db.projectMember.findMany({
		where: {
			projectId,
			userId: { in: userIds },
			acceptedAt: { not: null },
		},
		select: { userId: true },
	});
	for (const m of projectMembers) {
		allowed.add(m.userId);
	}

	return Array.from(allowed);
}

/**
 * Resolve `@username` tokens to user IDs, scoped to people who are
 * plausibly part of the project's collaboration surface — either an
 * org member of the project's host org or an active ProjectMember row.
 *
 * Returns an empty array when no usernames or no matches. Read-time
 * access filtering still applies, so this is a soft narrowing — its
 * job is to avoid creating notifications for total strangers, not to
 * enforce final visibility.
 */
export async function resolveMentionedUserIds(
	usernames: string[],
	projectId: string,
	organizationId: string | null,
): Promise<string[]> {
	if (usernames.length === 0) {
		return [];
	}

	const users = await db.user.findMany({
		where: { username: { in: usernames } },
		select: { id: true },
	});
	const candidateIds = users.map((u) => u.id);
	return filterAuthorizedMentionRecipients(
		candidateIds,
		projectId,
		organizationId,
	);
}

// Distinct group sigil (#1767 Stage 5). `@@` can never match USERNAME_PATTERN:
// the second `@` is not preceded by start/whitespace, and the first `@` is
// followed by `@` (outside the username char class). Kept fully separate from
// extractUserMentions so a real username is never shadowed.
const GROUP_MENTION_PATTERN =
	/(^|\s)@@([a-z][a-z0-9-]{1,40})(?=$|\s|[:,.!?])/gi;

/**
 * Extract distinct function-tag groups addressed by `@@<slug>` tokens, in
 * first-seen order. Unknown slugs are ignored. Empty array when none.
 */
export function extractGroupMentions(content: string): FunctionTag[] {
	if (!content) {
		return [];
	}
	const seen = new Set<FunctionTag>();
	const out: FunctionTag[] = [];
	for (const match of content.matchAll(GROUP_MENTION_PATTERN)) {
		const slug = match[2]?.toLowerCase();
		if (!slug) {
			continue;
		}
		const tag = GROUP_SLUG_TO_TAG[slug];
		if (tag && !seen.has(tag)) {
			seen.add(tag);
			out.push(tag);
		}
	}
	return out;
}
