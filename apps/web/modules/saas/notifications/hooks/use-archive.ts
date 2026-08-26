"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Archive notifications by id. Invalidates the tenant-scoped notifications
 * query cache so the active list (whatever tab the user is on) refetches
 * and the unread badge updates.
 */
export function useArchiveNotifications() {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: (ids: string[]) =>
			orpcClient.notifications.archive({ ids, organizationId }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["tenant", organizationId, "notifications"],
			});
		},
	});
}

/**
 * Restore archived notifications by id. Pair with `useArchiveNotifications`
 * for an Undo affordance after an archive action.
 */
export function useRestoreNotifications() {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: (ids: string[]) =>
			orpcClient.notifications.restore({ ids, organizationId }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["tenant", organizationId, "notifications"],
			});
		},
	});
}
