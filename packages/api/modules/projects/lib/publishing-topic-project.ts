/**
 * The Publishing Suite's project ratchet, in one place.
 *
 * SOC 2 CC6.1/CC6.3 — see `__tests__/input-org-unverified-ratchet.test.ts`.
 * `requireProjectPermission` proves the caller is authorized for THIS project
 * (object-level, resolved on `(projectId, userId)`), but it never inspects the
 * ORG. So the tenant must be derived from the loaded Project row rather than
 * resolved from caller input, and `organizationId` on the request is treated as
 * a guard, never as a scoping key.
 *
 * Extracted rather than copied: two procedures now open publishing work on a
 * project, and a security check that exists twice is a security check that can
 * drift once.
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";

export interface EligiblePublishingProject {
	id: string;
	organizationId: string | null;
}

/**
 * Load the project a publishing write is about, or throw the ORPC error the
 * caller should see.
 *
 * `status: "ACTIVE", deletedAt: null` is part of the identity here, not a
 * nicety: an archived or soft-deleted project must not receive new work, and
 * the downstream writers re-apply the same filter under their own row lock. A
 * caller told the work started for a project that will silently refuse it is
 * worse off than one told it does not exist.
 *
 * `findFirst`, not `findUnique`, because the extra conjuncts are filters rather
 * than identifiers.
 */
export async function requireEligibleProjectForTopic(input: {
	projectId: string;
	/**
	 * The org the client believes this project is in. Only a POSITIVELY-WRONG
	 * non-null value is rejected: null or omitted always passes, because a guest
	 * on a personal-context page legitimately sends null even for an org-owned
	 * project.
	 */
	clientOrganizationId?: string | null;
}): Promise<EligiblePublishingProject> {
	const project = await db.project.findFirst({
		where: { id: input.projectId, status: "ACTIVE", deletedAt: null },
		select: { id: true, organizationId: true },
	});
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}

	if (
		input.clientOrganizationId != null &&
		input.clientOrganizationId !== (project.organizationId ?? null)
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: "organizationId does not match the project",
		});
	}

	return project;
}
