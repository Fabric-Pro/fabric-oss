export interface LastActiveWorkspaceInput<
	TOrganization extends { id: string; slug: string },
> {
	userId: string;
	/** The caller's org membership list (already fetched, no extra query). */
	organizations: TOrganization[];
	/**
	 * Loads `user.lastActiveOrganizationId` from the DB.
	 * Injected so the decision matrix is testable without a DB connection.
	 */
	getLastActiveOrganizationId: (userId: string) => Promise<string | null>;
}

/**
 * The organization this person last worked in, or `null` when there is no
 * usable record of one.
 *
 * Returns the membership itself rather than a URL. The caller needs the
 * organization's id as well as its slug — it aligns the session with wherever
 * it sends the user — and handing back a formatted path would make it rebuild
 * the URL only to match it back against the same list to recover the id. That
 * round trip through a string is silent when it breaks: any change to the path
 * shape stops matching, the caller falls through to its next source, and the
 * user lands in the wrong workspace with nothing to show for it.
 *
 * `null` means one of two things, and the caller treats them alike: the account
 * has no last-active record yet, or the record names an organization it no
 * longer belongs to.
 */
export async function resolveLastActiveWorkspace<
	TOrganization extends { id: string; slug: string },
>({
	userId,
	organizations,
	getLastActiveOrganizationId,
}: LastActiveWorkspaceInput<TOrganization>): Promise<TOrganization | null> {
	const lastActiveOrganizationId = await getLastActiveOrganizationId(userId);

	if (!lastActiveOrganizationId) {
		return null;
	}

	return (
		organizations.find((org) => org.id === lastActiveOrganizationId) ?? null
	);
}
