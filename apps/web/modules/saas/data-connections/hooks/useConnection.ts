/**
 * useConnection Hook
 *
 * Fetches a single data connection with detailed info.
 */

"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";

export function useConnection(
	connectionId: string | undefined,
	options?: { refetchInterval?: number | false },
) {
	const { organizationId } = useOrganizationContext();

	return useQuery({
		queryKey: ["data-connection", connectionId, organizationId],
		queryFn: async () => {
			if (!connectionId) {
				return null;
			}
			const result = await orpcClient.dataConnections.get({
				id: connectionId,
				organizationId: organizationId ?? null,
			});
			return result.connection;
		},
		enabled: !!connectionId,
		refetchInterval: options?.refetchInterval,
	});
}
