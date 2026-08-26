"use client";

import { useTenantContext } from "@shared/hooks/use-tenant-query";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** The curated, user-toggleable notification categories. */
export type NotificationPreferenceFlags = {
	mentions: boolean;
	replies: boolean;
	assignments: boolean;
	status: boolean;
	syncProject: boolean;
	aiAgent: boolean;
	reportEmails: boolean;
	reviewEmails: boolean;
	publishingSuggestions: boolean;
	publishingEmails: boolean;
};

export type NotificationPreferences = NotificationPreferenceFlags & {
	/** False when the user has no PM-tool integration → grey out the sync toggle (AC-7). */
	syncIntegrationAvailable: boolean;
	/**
	 * Display-only (#2117) — render notifications as stacked cards. Kept OUT of
	 * `NotificationPreferenceFlags` on purpose: that type mirrors the server's
	 * delivery-gate flags, and a style preference gates no delivery.
	 */
	stackedCardStyle: boolean;
};

/** Anything the update mutation accepts: delivery flags plus the display flag. */
export type NotificationPreferenceUpdate =
	Partial<NotificationPreferenceFlags> & {
		stackedCardStyle?: boolean;
	};

/**
 * Read the current user's account-global notification preferences. Keyed under
 * the tenant prefix to sit alongside the other notification queries (the data
 * itself is account-global, so switching workspace simply refetches the same
 * row).
 */
export function useNotificationPreferences() {
	const { queryKeyPrefix } = useTenantContext();
	return useQuery({
		queryKey: [...queryKeyPrefix, "notifications", "preferences"],
		queryFn: () => orpcClient.notifications.getPreferences(),
	});
}

/**
 * Toggle notification categories with an optimistic update so the switch
 * responds immediately (DV-2: no reload). Rolls back on error and invalidates
 * the preference + notification caches on settle.
 */
export function useUpdateNotificationPreferences() {
	const queryClient = useQueryClient();
	const { queryKeyPrefix, organizationId } = useTenantContext();
	const key = [...queryKeyPrefix, "notifications", "preferences"];

	return useMutation({
		mutationFn: (input: NotificationPreferenceUpdate) =>
			orpcClient.notifications.updatePreferences(input),
		onMutate: async (input) => {
			await queryClient.cancelQueries({ queryKey: key });
			const previous =
				queryClient.getQueryData<NotificationPreferences>(key);
			if (previous) {
				queryClient.setQueryData<NotificationPreferences>(key, {
					...previous,
					...input,
				});
			}
			return { previous };
		},
		onError: (_err, _input, context) => {
			if (context?.previous) {
				queryClient.setQueryData(key, context.previous);
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: key });
			// Future deliveries change, so refresh lists + unread badge too.
			queryClient.invalidateQueries({
				queryKey: ["tenant", organizationId, "notifications"],
			});
		},
	});
}

/**
 * Whether to draw notifications as stacked cards (#2117).
 *
 * Call this in a list CONTAINER and pass `stacked` down — not in each row.
 *
 * `isLoading` is returned so the container can hold its skeleton until the
 * style is known; without that, an opted-in reader watches compact rows
 * repaint into cards. It is deliberately the query's loading flag rather than
 * a `data === undefined` check: the global QueryClient sets `retry: false`, so
 * a failed preference fetch settles with `data` still undefined, and gating on
 * that would leave the list stuck in a skeleton forever. On failure this
 * resolves to the compact default instead.
 */
export function useStackedCardStyle(): {
	stacked: boolean;
	isLoading: boolean;
} {
	const { data, isLoading } = useNotificationPreferences();
	return { stacked: data?.stackedCardStyle ?? false, isLoading };
}
