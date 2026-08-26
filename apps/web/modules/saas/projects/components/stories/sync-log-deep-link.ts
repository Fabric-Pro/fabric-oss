"use client";

/**
 * Roadmap-side half of the sync-log deep link (`buildProjectSyncLogRoute`
 * builds the other half).
 *
 * The sync log lives inside a modal on the Roadmap tab, so it has no route of
 * its own. `?history=sync` addresses it: `ProjectDetails` already honours
 * `?tab=stories` to land on the Roadmap, and `StoriesRoadmap` consumes
 * `history=sync` here to open the modal pre-scoped to Sync History.
 *
 * Both entry points — the Project Management settings link and the Review
 * Center footer — navigate to the CANONICAL route from
 * `buildProjectSyncLogRoute`, never to "current URL plus the param". Copying
 * the current query is what broke the footer: a stale `?tab=settings` survives
 * there (any "Check Configuration" CTA writes it, and a manual tab switch does
 * not rewrite the URL), so `ProjectDetails`' `?tab=` effect yanked the user
 * back to Settings — unmounting the roadmap before the modal could open, and
 * stranding `history=sync` in the URL.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
	buildProjectSyncLogRoute,
	SYNC_LOG_PARAM,
	SYNC_LOG_PARAM_VALUE,
} from "../../lib/stories/routes";

/**
 * Consume `?history=sync` deep links, stripping the param each time so
 * dismissing the modal (or remounting the tab) doesn't reopen it.
 *
 * Returns a counter that increments once per link followed — 0 means "never
 * requested". A counter rather than a boolean so a second visit to the link
 * within the same mount still reaches consumers, whose effects key on the value.
 *
 * The effect keys on the serialized query, NOT the `useSearchParams()` object:
 * that object is a fresh instance per render, so an object dep re-runs the
 * effect on every render — which, since the effect sets state, is an infinite
 * render loop.
 */
export function useSyncLogDeepLink(): number {
	const router = useRouter();
	const pathname = usePathname();
	const search = useSearchParams().toString();
	const [requests, setRequests] = useState(0);

	useEffect(() => {
		const next = new URLSearchParams(search);
		if (next.get(SYNC_LOG_PARAM) !== SYNC_LOG_PARAM_VALUE) {
			return;
		}
		setRequests((n) => n + 1);

		next.delete(SYNC_LOG_PARAM);
		const query = next.toString();
		router.replace(query ? `${pathname}?${query}` : pathname, {
			scroll: false,
		});
	}, [search, pathname, router]);

	return requests;
}

/**
 * Open the sync log from inside the roadmap (the Review Center footer). Targets
 * the same canonical route as the settings link, so the destination has exactly
 * one definition and no stale param can ride along.
 */
export function useOpenSyncLog(projectId: string): () => void {
	const router = useRouter();
	const { basePath } = useOrganizationContext();

	return useCallback(() => {
		router.replace(buildProjectSyncLogRoute(basePath, projectId), {
			scroll: false,
		});
	}, [router, basePath, projectId]);
}
