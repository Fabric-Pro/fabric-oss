"use client";

import { useTenantContext } from "@shared/hooks/use-tenant-query";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Delivery-channel preferences — WHERE notifications are delivered. In-app is
 * always on and not represented here; only the opt-in external channels are.
 */
export type NotificationDeliveryPreferences = {
	emailEnabled: boolean;
	webhookEnabled: boolean;
	/** Decrypted webhook endpoint, or null when none is configured. */
	webhookUrl: string | null;
	/** Whether a signing secret exists. The secret itself is never returned. */
	hasWebhookSecret: boolean;
};

export type UpdateDeliveryPreferencesInput = {
	emailEnabled?: boolean;
	webhookEnabled?: boolean;
	/** Empty string clears the stored URL. */
	webhookUrl?: string;
};

/**
 * Read the current user's account-global delivery preferences. Keyed under the
 * tenant prefix to sit alongside the other notification queries (the data is
 * account-global, so switching workspace just refetches the same row).
 */
export function useNotificationDeliveryPreferences() {
	const { queryKeyPrefix } = useTenantContext();
	return useQuery({
		queryKey: [...queryKeyPrefix, "notifications", "delivery-preferences"],
		queryFn: () => orpcClient.notifications.getDeliveryPreferences(),
	});
}

/**
 * Update delivery channels. The email toggle gets an optimistic update so the
 * switch responds immediately; webhook config (URL/secret) is reconciled from
 * the server response. Rolls back on error and invalidates on settle.
 */
export function useUpdateNotificationDeliveryPreferences() {
	const queryClient = useQueryClient();
	const { queryKeyPrefix } = useTenantContext();
	const key = [...queryKeyPrefix, "notifications", "delivery-preferences"];

	return useMutation({
		mutationFn: (input: UpdateDeliveryPreferencesInput) =>
			orpcClient.notifications.updateDeliveryPreferences(input),
		onMutate: async (input) => {
			await queryClient.cancelQueries({ queryKey: key });
			const previous =
				queryClient.getQueryData<NotificationDeliveryPreferences>(key);
			// Optimistically reflect the boolean toggles only — URL/secret state
			// comes back authoritatively from the server.
			if (previous) {
				queryClient.setQueryData<NotificationDeliveryPreferences>(key, {
					...previous,
					...(input.emailEnabled !== undefined && {
						emailEnabled: input.emailEnabled,
					}),
					...(input.webhookEnabled !== undefined && {
						webhookEnabled: input.webhookEnabled,
					}),
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
		},
	});
}

/** Rotate the webhook signing secret. The new secret is returned once. */
export function useRotateWebhookSecret() {
	const queryClient = useQueryClient();
	const { queryKeyPrefix } = useTenantContext();
	const key = [...queryKeyPrefix, "notifications", "delivery-preferences"];

	return useMutation({
		mutationFn: () => orpcClient.notifications.rotateWebhookSecret(),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: key });
		},
	});
}
