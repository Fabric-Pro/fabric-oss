/**
 * Decision logic for the guest landing redirect on the `/app` start page.
 *
 * A user whose only access is a guest membership on an organization's
 * project (zero org memberships, zero personal projects) has nothing to
 * see on the personal dashboard — they should land directly on their
 * invited project instead.
 *
 * All data access is injected so the full decision matrix is
 * unit-testable without booting the server component. Loaders are only
 * invoked once the preceding conditions hold, so callers pay no extra
 * queries on the common paths (org members, personal-project users).
 */
export interface GuestLandingRedirectInput {
	/** Number of organization memberships the user holds. */
	organizationCount: number;
	userId: string;
	/**
	 * Only auto-redirect a guest to their project on the post-login hop. A bare
	 * /app visit (clicking "Start") returns null so the guest reaches home, where
	 * the welcome widget greets them.
	 */
	isPostLogin: boolean;
	/**
	 * Existence check for personal-context (`organizationId: null`)
	 * projects the user owns or is an accepted, unexpired member of.
	 */
	hasAnyPersonalProject: (userId: string) => Promise<boolean>;
	/**
	 * Resolves the user's most recently accepted, unexpired guest
	 * membership on an org project to its landing URL, or null when none.
	 */
	findGuestLandingTarget: (userId: string) => Promise<string | null>;
}

/**
 * Returns the redirect target for an org-project guest, or `null` when
 * the user should stay on the personal dashboard (or when the existing
 * org-redirect branches own the decision).
 */
export async function resolveGuestLandingRedirect({
	organizationCount,
	userId,
	isPostLogin,
	hasAnyPersonalProject,
	findGuestLandingTarget,
}: GuestLandingRedirectInput): Promise<string | null> {
	// Only auto-redirect on the post-login hop; a deliberate /app visit lets
	// the guest land on home (where the welcome widget greets them).
	if (!isPostLogin) {
		return null;
	}

	// Any org membership → the existing org-redirect branches own the
	// landing decision; never redirect from here.
	if (organizationCount > 0) {
		return null;
	}

	// Any personal project → preserve the personal dashboard.
	if (await hasAnyPersonalProject(userId)) {
		return null;
	}

	// Zero orgs and zero personal projects: if the user holds a guest
	// project membership, land them on that project.
	return await findGuestLandingTarget(userId);
}
