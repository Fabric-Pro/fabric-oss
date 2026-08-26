export interface LastActiveWorkspaceRedirectInput {
	userId: string;
	/** The caller's org membership list (already fetched, no extra query). */
	organizations: Array<{ id: string; slug: string }>;
	/**
	 * Loads `user.lastActiveOrganizationId` from the DB.
	 * Injected so the decision matrix is testable without a DB connection.
	 */
	getLastActiveOrganizationId: (userId: string) => Promise<string | null>;
}

/**
 * Returns a redirect URL if the user has a valid last-active org to return
 * to, or `null` to fall through to the caller's existing logic.
 *
 * null lastActiveOrganizationId means the user was last in their personal
 * workspace — the caller should show the personal dashboard (no redirect).
 */
export async function resolveLastActiveWorkspaceRedirect({
	userId,
	organizations,
	getLastActiveOrganizationId,
}: LastActiveWorkspaceRedirectInput): Promise<string | null> {
	const lastActiveOrganizationId = await getLastActiveOrganizationId(userId);

	if (!lastActiveOrganizationId) {
		return null;
	}

	const lastOrg = organizations.find(
		(org) => org.id === lastActiveOrganizationId,
	);
	if (!lastOrg) {
		return null;
	}

	return `/app/${lastOrg.slug}`;
}
