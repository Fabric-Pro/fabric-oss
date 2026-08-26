"use client";

import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { useTenantQuery } from "@shared/hooks/use-tenant-query";
import { orpcClient } from "@shared/lib/orpc-client";

export interface ProjectShortcut {
	id: string;
	name: string;
	/** Null for a personal project; the host org's slug for a guest-held one. */
	organizationSlug: string | null;
	isFavorite: boolean;
}

/**
 * Up to three quick-access project shortcuts for the navigation (#1694).
 *
 * Three properties of this query are load-bearing:
 *
 * - **Tenant-keyed.** `useTenantQuery` prefixes the cache key with the resolved
 *   organization, which comes from the URL rather than the session. The session's
 *   active organization is shared across browser tabs, so keying on it would let
 *   a tab open on one organization render another's project names.
 *
 * - **Flag-gated at the query, not just the render.** A default-off flag must
 *   cost nothing; gating only the JSX would still pay for the request.
 *
 * - **No polling.** The navigation already hosts three data-consuming widgets
 *   and shares one per-origin connection budget with them. This fetches once per
 *   tenant per session and is invalidated by the favorite mutation instead.
 */
export function useProjectShortcuts() {
	const enabled = useFeatureFlag("PROJECT_SHORTCUTS");
	// A project-scoped guest is presented the PERSONAL workspace, so their
	// shortcuts resolve in personal context — where the resolution's guest arm
	// picks up their host-org projects. This must be explicit rather than
	// incidental: a shortcut link carries the guest to `/app/{hostSlug}/...`,
	// after which the tenant hook would report the host org, and the server
	// rejects a caller with no membership in the org they named.
	const isGuest = useIsGuestInOrg();

	const { data, isError } = useTenantQuery<{ shortcuts: ProjectShortcut[] }>({
		baseKey: PROJECT_SHORTCUTS_BASE_KEY,
		// Forced personal for guests; auto-detected from the URL otherwise.
		organizationId: isGuest ? null : undefined,
		queryFn: (organizationId) =>
			orpcClient.projects.shortcuts({
				// Explicit null, never undefined — an omitted value falls back to
				// the session's active organization on the server.
				organizationId: organizationId ?? null,
			}) as Promise<{ shortcuts: ProjectShortcut[] }>,
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});

	// A failed load degrades to no shortcuts rather than an error surface: the
	// rest of the navigation must keep working. Pending resolves the same way,
	// so nothing reserves space and the items below never shift twice.
	return isError ? [] : (data?.shortcuts ?? []);
}

/** Shared so the favorite mutation can invalidate exactly this query. */
export const PROJECT_SHORTCUTS_BASE_KEY = ["projects", "shortcuts"] as const;
