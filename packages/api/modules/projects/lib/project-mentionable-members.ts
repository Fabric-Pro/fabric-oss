import { db } from "@repo/database";

/**
 * The people who may be @-mentioned or assigned inside a project.
 *
 * The candidate set mirrors `hasProjectAccess`: project owner ∪ accepted,
 * non-expired ProjectMembers. Organization membership alone does not qualify —
 * it must come paired with a ProjectMember row, the same rule that governs
 * document read access. That is what guarantees you can only name somebody who
 * can actually see the thing you are naming them on.
 *
 * Extracted from `search-mentionables.ts` so question assignment (Fizzy #1751)
 * resolves the same set. Only the *member* half moved: function-tag groups stay
 * with the document procedure, because a group is mentionable but not
 * assignable — AC-3 scopes assignment to project members.
 */
export interface MentionableMember {
	id: string;
	name: string | null;
	email: string | null;
	avatarUrl: string | null;
}

export interface ListProjectMentionableMembersInput {
	projectId: string;
	/** Case-insensitive match against name or email. Empty returns everyone. */
	query: string;
	/**
	 * Maximum rows returned. The document mention popover wants a short
	 * typeahead; the assignee picker opens with nothing typed and needs a
	 * browsable list, so it asks for more.
	 */
	limit: number;
}

/**
 * Returns `null` when the project does not exist, so callers can raise their own
 * NOT_FOUND with wording that suits their surface.
 */
export async function listProjectMentionableMembers({
	projectId,
	query,
	limit,
}: ListProjectMentionableMembersInput): Promise<MentionableMember[] | null> {
	const [project, projectMembers] = await Promise.all([
		db.project.findUnique({
			where: { id: projectId },
			select: {
				id: true,
				user: {
					select: { id: true, name: true, email: true, image: true },
				},
			},
		}),
		db.projectMember.findMany({
			where: {
				projectId,
				acceptedAt: { not: null },
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
			select: { userId: true },
		}),
	]);

	if (!project) {
		return null;
	}

	const memberUsers = projectMembers.length
		? await db.user.findMany({
				where: { id: { in: projectMembers.map((m) => m.userId) } },
				select: { id: true, name: true, email: true, image: true },
			})
		: [];

	const candidates = new Map<string, MentionableMember>();
	candidates.set(project.user.id, {
		id: project.user.id,
		name: project.user.name,
		email: project.user.email,
		avatarUrl: project.user.image,
	});
	for (const u of memberUsers) {
		if (!candidates.has(u.id)) {
			candidates.set(u.id, {
				id: u.id,
				name: u.name,
				email: u.email,
				avatarUrl: u.image,
			});
		}
	}

	const needle = query.trim().toLowerCase();
	const filtered = needle.length
		? Array.from(candidates.values()).filter((c) => {
				const nameMatch =
					c.name?.toLowerCase().includes(needle) ?? false;
				const emailMatch =
					c.email?.toLowerCase().includes(needle) ?? false;
				return nameMatch || emailMatch;
			})
		: Array.from(candidates.values());

	// Sort by name ASC; null names last. Stable by id within a tier.
	filtered.sort((a, b) => {
		if (a.name === null && b.name === null) {
			return a.id.localeCompare(b.id);
		}
		if (a.name === null) {
			return 1;
		}
		if (b.name === null) {
			return -1;
		}
		return a.name.localeCompare(b.name);
	});

	return filtered.slice(0, limit);
}
