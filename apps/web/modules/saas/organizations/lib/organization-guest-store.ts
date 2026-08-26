/**
 * Browser-session store for the server-seeded "is the viewer a
 * project-scoped guest in this org?" flag, keyed by organization slug.
 *
 * Why this exists: `ActiveOrganizationProvider` (and therefore the
 * `useActiveOrganizationQuery` instance that loads the active org) is
 * mounted by `app/(saas)/layout.tsx` — ABOVE the org-scoped layout that
 * computes the guest flag server-side. React context seeded by the org
 * layout can never reach that hook instance, so the org layout's
 * `OrganizationGuestProvider` mirrors the flag into this module store
 * where the query function can read it at fetch time and skip the
 * Better Auth membership probe (which always 403s for guests).
 *
 * Timing guarantee: the provider writes during render; TanStack Query
 * fires fetches in passive effects, and all render-phase work for a
 * committed tree completes before any passive effect runs — so the
 * first fetch for an org page always observes the seed.
 *
 * NOT a React state container — values are server truth snapshotted at
 * the last server render of the org layout and refresh on navigation.
 * Deliberately a plain module (no "use client") so `lib/api.ts`, which
 * server layouts import for query keys, does not pull a client-marked
 * module into a server graph.
 */

const seededGuestFlags = new Map<string, boolean>();

/**
 * Record the server-computed guest flag for an organization slug.
 * No-op during SSR — module scope is shared across requests on the
 * server, and the store must never carry one user's flag into another
 * user's render. The browser hydration render performs the real write.
 */
export function seedOrganizationGuestFlag(
	organizationSlug: string,
	isGuest: boolean,
): void {
	if (typeof window === "undefined") {
		return;
	}
	seededGuestFlags.set(organizationSlug, isGuest);
}

/**
 * Read the seeded guest flag for a slug. `undefined` means "no org
 * layout has seeded this slug yet" — callers must fall back to their
 * existing detection path (probe + fallback) in that case.
 */
export function getSeededOrganizationGuestFlag(
	organizationSlug: string,
): boolean | undefined {
	return seededGuestFlags.get(organizationSlug);
}

/** Test-only helper — clears all seeded flags between test cases. */
export function resetSeededOrganizationGuestFlags(): void {
	seededGuestFlags.clear();
}
