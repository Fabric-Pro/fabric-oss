/**
 * useResources Hooks
 *
 * Hooks for managing synced resources on a data connection.
 */

"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useResources(connectionId: string | undefined) {
	const { organizationId } = useOrganizationContext();

	return useQuery({
		queryKey: ["data-connection-resources", connectionId, organizationId],
		queryFn: async () => {
			if (!connectionId) {
				return null;
			}
			const result = await orpcClient.dataConnections.resources.list({
				id: connectionId,
				organizationId: organizationId ?? null,
				limit: 100,
				offset: 0,
			});
			return result.resources;
		},
		enabled: !!connectionId,
	});
}

export function useExcludeResource(connectionId: string) {
	const queryClient = useQueryClient();
	const { organizationId } = useOrganizationContext();

	return useMutation({
		mutationFn: async (externalId: string) => {
			return await orpcClient.dataConnections.resources.exclude({
				id: connectionId,
				externalId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["data-connection-resources", connectionId],
			});
		},
	});
}

export function useIncludeResource(connectionId: string) {
	const queryClient = useQueryClient();
	const { organizationId } = useOrganizationContext();

	return useMutation({
		mutationFn: async (externalId: string) => {
			return await orpcClient.dataConnections.resources.include({
				id: connectionId,
				externalId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["data-connection-resources", connectionId],
			});
		},
	});
}

export function useResourceContent(
	connectionId: string | undefined,
	resourceId: string | undefined,
) {
	const { organizationId } = useOrganizationContext();

	return useQuery({
		queryKey: [
			"data-connection-resource-content",
			connectionId,
			resourceId,
			organizationId,
		],
		queryFn: async () => {
			if (!connectionId || !resourceId) {
				return null;
			}
			return await orpcClient.dataConnections.resources.getContent({
				id: connectionId,
				resourceId,
				organizationId: organizationId ?? null,
			});
		},
		enabled: !!connectionId && !!resourceId,
	});
}

export function useNotionPages(
	connectionId: string | undefined,
	query?: string,
) {
	const { organizationId } = useOrganizationContext();

	return useQuery({
		queryKey: ["notion-pages", connectionId, organizationId, query],
		queryFn: async () => {
			if (!connectionId) {
				return null;
			}
			const result = await orpcClient.dataConnections.notion.pages({
				id: connectionId,
				organizationId: organizationId ?? null,
				query: query ?? "",
			});
			return result.pages;
		},
		enabled: !!connectionId,
	});
}
