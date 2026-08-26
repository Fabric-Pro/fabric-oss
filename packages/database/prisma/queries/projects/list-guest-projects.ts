/**
 * "Shared with me" projects for the Personal workspace.
 *
 * Lists org-context projects (`organizationId != null`) where the user is a
 * project-scoped GUEST: they hold an accepted (`acceptedAt != null`),
 * unexpired (`expiresAt` null or in the future) `ProjectMember` row on the
 * project, but have NO `Member` row in the project's organization. Real org
 * members are excluded on purpose — their projects already surface in the org
 * workspace grid, so re-listing them under "Shared with me" would duplicate
 * entries the moment they switch workspaces.
 *
 * The member sub-filter mirrors the `listProjects` access predicate (see
 * `projects.ts`) so "accepted + unexpired" means the same thing on both
 * surfaces. Soft-deleted projects are excluded; the select is exactly the
 * `ProjectCard` shape (including the `_count.contexts` filter that hides
 * contexts which only back imported documents, matching `listProjects`).
 *
 * Used by the `projects.listGuest` oRPC procedure to render the
 * "Shared with me" section below the personal projects grid.
 */
import { db } from "../../client";
import { withFavoriteFlag } from "./projects";

export async function listGuestProjects(userId: string) {
	const projects = await db.project.findMany({
		where: {
			organizationId: { not: null },
			deletedAt: null,
			members: {
				some: {
					userId,
					acceptedAt: { not: null },
					OR: [
						{ expiresAt: null },
						{ expiresAt: { gt: new Date() } },
					],
				},
			},
			// Guest-only: exclude orgs the user is a real member of.
			organization: {
				members: { none: { userId } },
			},
		},
		select: {
			id: true,
			userId: true,
			name: true,
			description: true,
			status: true,
			projectTypes: true,
			tags: true,
			color: true,
			icon: true,
			createdAt: true,
			updatedAt: true,
			// Caller-scoped favorite state (#1694). A guest's shared projects
			// reach the list through this query rather than listProjects, so the
			// favorite control needs its state here too.
			userPreferences: {
				where: { userId },
				select: { favoritedAt: true },
				take: 1,
			},
			organization: {
				select: {
					id: true,
					slug: true,
					name: true,
				},
			},
			_count: {
				select: {
					documents: true,
					contexts: {
						where: { importedDocuments: { none: {} } },
					},
				},
			},
		},
		orderBy: { updatedAt: "desc" },
	});

	// One flatten for every read that selects the relation, so the three cannot
	// drift apart on how a null preference row is interpreted.
	return projects.map(withFavoriteFlag);
}
