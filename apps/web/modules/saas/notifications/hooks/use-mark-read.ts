"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export function useMarkNotificationsRead() {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: (ids: string[]) =>
			orpcClient.notifications.markRead({ ids }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["tenant", organizationId, "notifications"],
			});
		},
	});
}

export function useMarkAllNotificationsRead() {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: () =>
			orpcClient.notifications.markAllRead({ organizationId }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["tenant", organizationId, "notifications"],
			});
		},
	});
}
