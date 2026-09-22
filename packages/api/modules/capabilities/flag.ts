/**
 * Whether capability gating is on for one project (Fizzy #1930).
 *
 * The flag is organization-scopable, and an organization override only counts
 * when the organization is passed to the lookup — without it the answer is the
 * global one, so enabling gating for one organization in the console did
 * nothing, and opting one out of a global rollout did nothing either.
 *
 * The organization is always the PROJECT's own, read here, never the session's
 * active one. A person viewing a project outside their active organization
 * would otherwise get the drawing decided by one tenant's flag and the doors
 * by another's, and the page and the refusal would disagree.
 */

import { db, isFeatureEnabled } from "@repo/database";

export async function isCapabilityGatingEnabled(
	projectId: string,
): Promise<boolean> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	return isFeatureEnabled(
		"CAPABILITY_GATING",
		project?.organizationId ?? undefined,
	);
}
