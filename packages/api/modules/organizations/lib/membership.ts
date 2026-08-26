import { getOrganizationMembership } from "@repo/database";

export async function verifyOrganizationMembership(
	organizationId: string,
	userId: string,
) {
	const membership = await getOrganizationMembership(organizationId, userId);

	if (!membership) {
		return null;
	}

	return {
		organization: membership.organization,
		role: membership.role,
	};
}

/**
 * Require organization membership with optional role filtering
 *
 * @param userId - The user ID to check
 * @param organizationId - The organization ID to check membership for
 * @param allowedRoles - Optional array of allowed roles (e.g., ["owner", "admin"])
 * @returns Membership info if authorized, null otherwise
 */
export async function requireOrgMembership(
	userId: string,
	organizationId: string,
	allowedRoles?: string[],
) {
	const membership = await getOrganizationMembership(organizationId, userId);

	if (!membership) {
		return null;
	}

	// If specific roles are required, check that the user has one of them
	if (allowedRoles && allowedRoles.length > 0) {
		if (!allowedRoles.includes(membership.role)) {
			return null;
		}
	}

	return {
		organization: membership.organization,
		role: membership.role,
	};
}
