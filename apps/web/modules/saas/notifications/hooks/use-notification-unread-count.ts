"use client";

import { useTenantQuery } from "@shared/hooks/use-tenant-query";
import { orpcClient } from "@shared/lib/orpc-client";

const POLL_INTERVAL_MS = 30_000;

export function useNotificationUnreadCount() {
	return useTenantQuery({
		baseKey: ["notifications", "unreadCount"],
		queryFn: (organizationId) =>
			orpcClient.notifications.unreadCount({ organizationId }),
		refetchOnWindowFocus: true,
		refetchInterval: POLL_INTERVAL_MS,
		staleTime: POLL_INTERVAL_MS / 2,
	});
}
