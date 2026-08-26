import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useSeededGuestFlag } from "@saas/organizations/lib/organization-guest-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";

/**
 * True when the signed-in user has project-scoped guest access to the
 * current organization but no full membership.
 *
 * Resolution order:
 * 1. Server-seeded value from `OrganizationGuestContext` — the org
 *    layout computes `isGuestInOrg()` during its server render and
 *    seeds it via `OrganizationGuestProvider`, so on org pages the flag
 *    is correct on the FIRST client render (no shell flash) and no
 *    `organizations.isGuest` request fires at all.
 * 2. Fallback oRPC query — only for trees rendered without a seeded
 *    provider (e.g. outside the org layout). Returns false (default)
 *    while loading or when the user has no active org context.
 *
 * Frontend uses this to hide org-level nav items (settings, billing,
 * integrations, etc.) for guests — they would be redirected on click
 * anyway, so surfacing the links produces a confusing UX.
 *
 * Known edge case: when the user is in PERSONAL context (no active org),
 * this returns `false` and the full personal nav is rendered, even if the
 * user happens to be a guest in some other org they haven't switched to.
 * That's the deliberate default — their personal account still works
 * normally, and clicking an invited project from elsewhere switches them
 * into the host org context where the guest branch takes over. If product
 * decides a guest with no orgs of their own should ALWAYS see a trimmed
 * nav, swap this hook for a broader `useIsGuestOnlyUser()` that consults
 * all memberships instead of the active one.
 */
export function useIsGuestInOrg(): boolean {
	const seededIsGuest = useSeededGuestFlag();
	const { organizationId } = useOrganizationContext();
	const { data } = useQuery({
		...orpc.organizations.isGuest.queryOptions({
			input: { organizationId: organizationId ?? "" },
		}),
		// Seeded knowledge (true OR false) makes the round-trip redundant.
		enabled: seededIsGuest === undefined && !!organizationId,
		staleTime: 60_000,
	});
	return seededIsGuest ?? !!data?.isGuest;
}
