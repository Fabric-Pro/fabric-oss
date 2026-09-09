"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useParams } from "next/navigation";

/**
 * Whether the tenant the caller is standing in is known yet.
 *
 * Anything reading TENANT-scoped configuration has to answer this before it
 * asks, because `organizationId` alone cannot: it is null both when there is
 * genuinely no organization and when the URL names one that has not resolved.
 * Asking in the second case sends `organizationId: null`, which the status
 * procedure answers from its PERSONAL arm — so an organization page ends up
 * showing the caller's own configuration as though it were the organization's.
 *
 * `isResolvingOrganization` covers only half of it. It is the active-organization
 * query's loading flag, and that query does not retry, so a failed lookup leaves
 * the flag false with `organizationId` still null — the same wrong answer, but
 * cached under the null key and therefore immediate and lasting rather than a
 * flicker.
 *
 * So the route is the authority on whether an organization is expected, and the
 * resolved context on whether it has arrived. A slug in the URL with no id
 * behind it means "not yet, or not at all" — and either way, nothing
 * tenant-scoped may be asked for or shown.
 *
 * Shared between the two app-chrome banners deliberately. Their messages,
 * predicates, dismissal semantics and remedies all differ on purpose and are
 * documented as such; this is the one layer beneath them that has no reason to,
 * and it drifted once already when only one of them was given a guard.
 */
export function useTenantScopeResolved(): boolean {
	const params = useParams();
	const { organizationId } = useOrganizationContext();

	const routeExpectsOrganization =
		typeof params?.organizationSlug === "string";

	return !routeExpectsOrganization || organizationId !== null;
}
