/**
 * Existence check for personal-context projects.
 *
 * Uses the `listProjects` personal-context access filter (see `projects.ts`):
 * a personal project is a non-deleted `Project` row with an explicit
 * `organizationId: null` (multi-tenant XOR — null is required, never
 * undefined) that the user either owns or is an accepted, unexpired member
 * of. Soft-deleted projects (`deletedAt != null`) are excluded — they render
 * nowhere, so they must not count as "has a dashboard worth showing".
 *
 * DRAFT projects are intentionally counted (unlike the `listProjects`
 * default, which hides drafts from the grid): a draft the user owns is real
 * content, so its existence should still keep them on the personal dashboard
 * rather than redirecting them away to a guest project.
 *
 * Used by the `/app` landing page to decide whether a zero-org user still
 * has a personal dashboard worth showing before redirecting an org-project
 * guest to their invited project.
 */
import { db } from "../../client";

export async function hasAnyPersonalProject(userId: string): Promise<boolean> {
	const project = await db.project.findFirst({
		where: {
			organizationId: null,
			deletedAt: null,
			OR: [
				{ userId }, // User is owner
				{
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
				},
			],
		},
		select: { id: true },
	});

	return project !== null;
}
