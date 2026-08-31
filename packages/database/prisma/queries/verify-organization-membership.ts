/**
 * Shared membership check for tenants a caller names themselves.
 *
 * Every entry point where a caller supplies an organization id — a protocol
 * request header, a switch-organization tool argument — has to answer the same
 * question before honouring it: is this caller a member of that organization?
 * The check is one row lookup, and that is exactly why it is easy to write a
 * second, slightly different copy of it somewhere else. One implementation,
 * called from every selector, keeps the answer identical everywhere.
 *
 * Deliberately membership-only: it says nothing about the caller's ROLE inside
 * the organization. Role checks live with the operations that need them; this
 * helper answers "may this caller act in this tenant at all".
 */

import { db } from "../client";

/**
 * True when `userId` holds a membership row in `organizationId`.
 *
 * Both arguments are trusted to be non-empty strings; an empty or missing
 * organization id is a "caller named nothing" case, which is the caller's to
 * interpret, not this helper's. It returns `false` for one rather than
 * pretending an empty tenant is a real one.
 */
export async function isOrganizationMember(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	if (!userId || !organizationId) {
		return false;
	}

	const membership = await db.member.findFirst({
		where: { userId, organizationId },
		select: { id: true },
	});

	return membership !== null;
}

/**
 * True when `userId` has ANY legitimate tie to `organizationId` — a membership
 * row, or an accepted, unexpired project membership on a project the
 * organization owns.
 *
 * The second half is the project-scoped guest: someone invited to one project
 * inside an organization they do not belong to. `isOrganizationMember` says
 * false for them, correctly — they are not members — but a check that refuses
 * them refuses the guest path the product is built around, and that is a
 * regression rather than a boundary.
 *
 * Use this where the question is "may this caller act in this tenant at all",
 * as opposed to "is this caller a member". It is still a hard boundary: a
 * caller with neither tie is refused, so naming a tenant you have no
 * relationship with gets you nowhere.
 */
export async function hasOrganizationTie(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	if (!userId || !organizationId) {
		return false;
	}

	if (await isOrganizationMember(userId, organizationId)) {
		return true;
	}

	const projectMembership = await db.projectMember.findFirst({
		where: {
			userId,
			acceptedAt: { not: null },
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			project: { organizationId },
		},
		select: { id: true },
	});

	return projectMembership !== null;
}
