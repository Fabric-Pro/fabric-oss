"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { useTenantQuery } from "@shared/hooks/use-tenant-query";
import { orpcClient } from "@shared/lib/orpc-client";

const POLL_INTERVAL_MS = 30_000;

export function useNotificationUnreadCount() {
	const organizationId = useOrganizationId();
	return useTenantQuery({
		baseKey: ["notifications", "unreadCount"],
		queryFn: (organizationId) =>
			orpcClient.notifications.unreadCount({ organizationId }),
		// The server refuses a request with no organization, and the active
		// organization can still be unresolved on the first client render.
		enabled: organizationId !== null,
		refetchOnWindowFocus: true,
		refetchInterval: POLL_INTERVAL_MS,
		staleTime: POLL_INTERVAL_MS / 2,
	});
}
