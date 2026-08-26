"use client";

import { PROJECT_SHORTCUTS_BASE_KEY } from "@saas/projects/hooks/use-project-shortcuts";
import { createTenantQueryKey } from "@shared/hooks/use-tenant-query";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/**
 * Records that the caller opened this project (#1694).
 *
 * Deliberately NOT gated by the shortcuts feature flag. Recording starts at
 * ship so that flipping the flag on reveals a list that already reflects the
 * user's work, rather than an empty sub-nav for everyone on day one.
 *
 * Fire-and-forget: the call is not awaited and its rejection is swallowed, so a
 * failure can never delay or break the page it fires from. That is also why the
 * server, not this hook, is the authority on whether a visit may be recorded —
 * the procedure re-checks project access, so a stale bookmark to a project the
 * user lost access to writes nothing.
 *
 * `enabled` must be false until the project has actually resolved. Firing on a
 * not-found or soft-deleted view would record visits for projects the user
 * cannot open, which then compete for shortcut slots they can never use.
 */
export function useRecordProjectVisit({
	projectId,
	organizationId,
	enabled,
}: {
	projectId: string;
	organizationId: string | null;
	enabled: boolean;
}) {
	const queryClient = useQueryClient();
	// One record per project per mount. Without this, any re-render that
	// changes an unrelated dependency would re-fire the write.
	const recordedFor = useRef<string | null>(null);

	useEffect(() => {
		if (!enabled || recordedFor.current === projectId) {
			return;
		}
		recordedFor.current = projectId;

		// Both arms matter: `.catch` swallows a rejected request, the try/catch
		// swallows a synchronous throw. Recording is a side benefit of opening a
		// project, and must never be able to take the page down with it.
		try {
			void orpcClient.projects
				.recordVisit({ projectId, organizationId })
				.then(() => {
					// The shortcut query holds its result for the whole session,
					// so without this the project the user just opened does not
					// reach the front of their recency order until a reload.
					queryClient.invalidateQueries({
						queryKey: createTenantQueryKey(
							organizationId,
							PROJECT_SHORTCUTS_BASE_KEY,
						),
					});
				})
				.catch(() => {});
		} catch {
			// Silent by design — see the doc comment.
		}
	}, [enabled, projectId, organizationId, queryClient]);
}
