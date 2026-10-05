/**
 * The project an agent signed in for, and whether its owner may still read it.
 *
 * Asked twice over a grant's life with the same rule: at consent, before the
 * grant exists, and on every request that presents one of its tokens. A project
 * grant is not tied to the owner's membership of an organization, because a
 * guest invited to one project holds no such membership; it is tied to what the
 * app itself lets the person open, which is `getProjectAccessContext`.
 */

import { db } from "../client";
import { getProjectAccessContext } from "./projects/projects";

export interface OAuthProjectGrantTarget {
	projectId: string;
	projectName: string;
	/** The organization hosting the project. */
	organizationId: string;
	organizationName: string;
}

/**
 * The project and its organization, or null for every way the answer is "no":
 * the project does not exist or is deleted, it belongs to no organization, its
 * organization is being deleted, or the person cannot read it. One null for all
 * of them, so a caller cannot tell a missing project from one it may not see.
 */
export async function resolveOAuthProjectGrantTarget(
	userId: string,
	projectId: string,
): Promise<OAuthProjectGrantTarget | null> {
	const project = await db.project.findFirst({
		where: { id: projectId, deletedAt: null },
		select: {
			id: true,
			name: true,
			organizationId: true,
			organization: { select: { name: true, deletedAt: true } },
		},
	});
	if (
		!project?.organizationId ||
		!project.organization ||
		project.organization.deletedAt !== null
	) {
		return null;
	}

	if (!(await getProjectAccessContext(projectId, userId))) {
		return null;
	}

	return {
		projectId: project.id,
		projectName: project.name,
		organizationId: project.organizationId,
		organizationName: project.organization.name,
	};
}
