/**
 * Quick-access project shortcuts (#1694) — resolution and the two writes.
 *
 * Resolution runs **outward from the caller's own preference rows**, not inward
 * from every project they can reach. Starting from reachable projects would
 * load an entire project list on every page to pick three; starting from the
 * preference rows bounds the candidate set to something already indexed per
 * user, and applies reachability, tenancy and eligibility as a filter on the
 * related project.
 *
 * Two things about this file are load-bearing and easy to "simplify" wrongly:
 *
 * 1. **Null filters are not defensive.** Every preference row that predates
 *    #1694 carries null in both new columns, and PostgreSQL sorts nulls FIRST
 *    under a plain DESC ordering. Without `not: null` per branch, months-old
 *    welcome-widget rows outrank real visits — in production only, because a
 *    seeded test database has no legacy rows.
 *
 * 2. **The tenant boundary is the project, never the preference row.**
 *    `ProjectUserPreference.organizationId` is a denormalized copy of the
 *    project's org (see the kanban and welcome-widget writers), so a guest's row
 *    on a host-org project carries that host org while the guest browses in
 *    personal context. Filtering on it hides their own row from them. The model
 *    is registered in `PER_USER_ORG_TABLES` and carries a `per_user_within_org`
 *    RLS policy, both of which would do exactly that — which is why these
 *    queries stay on the direct client and scope by project reachability.
 */

import { db } from "../../client";
import type { Prisma } from "../../generated/client";

/** Statuses a project must not be in to earn a shortcut slot. */
const INELIGIBLE_STATUSES = ["DRAFT", "ARCHIVED"] as const;

export interface ProjectShortcut {
	id: string;
	name: string;
	/** Null for a personal project; the host org's slug for a guest-held one. */
	organizationSlug: string | null;
	isFavorite: boolean;
}

/**
 * Which projects may back a shortcut, for this caller in this context.
 *
 * Organization context mirrors the `listProjects` access predicate. Personal
 * context is a **two-arm union**, and both arms are required: the personal arm
 * alone drops every guest-held project (leaving a project-scoped guest a
 * permanently empty sub-nav), while dropping the org pin instead would surface a
 * full member's org projects inside their personal navigation.
 */
function reachableProjectFilter(
	userId: string,
	organizationId: string | null,
): Prisma.ProjectWhereInput {
	const acceptedMembership = {
		some: {
			userId,
			acceptedAt: { not: null },
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
	} satisfies Prisma.ProjectMemberListRelationFilter;

	const eligibility = {
		deletedAt: null,
		status: { notIn: [...INELIGIBLE_STATUSES] },
	} satisfies Prisma.ProjectWhereInput;

	if (organizationId) {
		return {
			...eligibility,
			organizationId,
			OR: [{ userId }, { members: acceptedMembership }],
		};
	}

	return {
		...eligibility,
		OR: [
			// Personal arm — the caller's own workspace.
			{
				organizationId: null,
				OR: [{ userId }, { members: acceptedMembership }],
			},
			// Guest arm — an org project shared with a caller who is NOT a member
			// of that org. The membership exclusion mirrors `listGuestProjects`;
			// without it a real org member's projects leak into personal context.
			{
				organizationId: { not: null },
				members: acceptedMembership,
				organization: { members: { none: { userId } } },
			},
		],
	};
}

const SHORTCUT_SELECT = {
	favoritedAt: true,
	project: {
		select: {
			id: true,
			name: true,
			organization: { select: { slug: true } },
		},
	},
} satisfies Prisma.ProjectUserPreferenceSelect;

type ShortcutRow = Prisma.ProjectUserPreferenceGetPayload<{
	select: typeof SHORTCUT_SELECT;
}>;

function toShortcut(row: ShortcutRow, isFavorite: boolean): ProjectShortcut {
	return {
		id: row.project.id,
		name: row.project.name,
		organizationSlug: row.project.organization?.slug ?? null,
		isFavorite,
	};
}

/**
 * Up to `limit` shortcuts: favorites first, remaining slots filled by recency.
 *
 * The merge happens here rather than in SQL because no single ordering expresses
 * "favorites by last visit with never-visited last by favorite date, then
 * non-favorites by last visit". Each branch reads at most `limit` rows, so the
 * work is bounded regardless of how many projects the caller can reach.
 */
export async function listProjectShortcuts({
	userId,
	organizationId,
	limit = 3,
}: {
	userId: string;
	organizationId: string | null;
	limit?: number;
}): Promise<ProjectShortcut[]> {
	const project = reachableProjectFilter(userId, organizationId);

	const [favorites, recents] = await Promise.all([
		db.projectUserPreference.findMany({
			where: { userId, favoritedAt: { not: null }, project },
			select: SHORTCUT_SELECT,
			orderBy: [
				// Never-visited favorites sort last, then by when they were starred.
				{ lastVisitedAt: { sort: "desc", nulls: "last" } },
				{ favoritedAt: "desc" },
			],
			take: limit,
		}),
		db.projectUserPreference.findMany({
			where: {
				userId,
				favoritedAt: null,
				lastVisitedAt: { not: null },
				project,
			},
			select: SHORTCUT_SELECT,
			orderBy: { lastVisitedAt: "desc" },
			take: limit,
		}),
	]);

	return [
		...favorites.map((row) => toShortcut(row, true)),
		...recents.map((row) => toShortcut(row, false)),
	].slice(0, limit);
}

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === UNIQUE_VIOLATION
	);
}

/**
 * Conditional write against the shared preference row, with create-on-miss.
 *
 * The favorite toggle and the visit recorder write the same row, so a plain
 * upsert lets one lose a create race and silently discard its own field — a user
 * would see a filled star, a success response, and no stored favorite. On a
 * create collision this **re-runs the conditional update** rather than reporting
 * success, so the losing writer still lands its value.
 *
 * `where` may carry extra guards (the visit writer's monotonic check). A zero
 * count after the row demonstrably exists therefore means "the guard rejected
 * it", which is a correct no-op, not a failure.
 */
type ShortcutFields = {
	favoritedAt?: Date | null;
	lastVisitedAt?: Date | null;
};

async function writeShortcutField(
	projectId: string,
	userId: string,
	fields: ShortcutFields,
	extraGuard: Prisma.ProjectUserPreferenceWhereInput = {},
): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const { count } = await db.projectUserPreference.updateMany({
			where: { projectId, userId, ...extraGuard },
			data: fields,
		});
		if (count > 0) {
			return;
		}

		// Only the create path needs the project's organization, and it is read
		// by id alone — deliberately NOT through a tenant-scoped lookup. Callers
		// authorize before reaching here, and a tenant-scoped read would fail to
		// find an org project for a guest resolving in personal context, which is
		// exactly the case this feature exists to serve.
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: { organizationId: true },
		});

		try {
			await db.projectUserPreference.create({
				// `organizationId` is denormalized from the project to stay
				// consistent with the existing writers on this table. It is not a
				// read filter — see the module header.
				data: {
					projectId,
					userId,
					organizationId: project?.organizationId ?? null,
					...fields,
				},
			});
			return;
		} catch (error) {
			if (!isUniqueViolation(error)) {
				throw error;
			}
			// Another writer created the row first. Loop and update it instead of
			// dropping this write on the floor.
		}
	}
}

/** Star or unstar a project for one user. Idempotent in both directions. */
export async function setProjectFavorite({
	projectId,
	userId,
	favorited,
	now = new Date(),
}: {
	projectId: string;
	userId: string;
	favorited: boolean;
	now?: Date;
}): Promise<void> {
	await writeShortcutField(projectId, userId, {
		favoritedAt: favorited ? now : null,
	});
}

/**
 * Record that the caller opened this project.
 *
 * Guarded so an out-of-order commit cannot move recency backwards: two tabs
 * opening the same project can commit in either order, and the later timestamp
 * must win.
 */
export async function recordProjectVisit({
	projectId,
	userId,
	now = new Date(),
}: {
	projectId: string;
	userId: string;
	now?: Date;
}): Promise<void> {
	await writeShortcutField(
		projectId,
		userId,
		{ lastVisitedAt: now },
		{ OR: [{ lastVisitedAt: null }, { lastVisitedAt: { lt: now } }] },
	);
}
