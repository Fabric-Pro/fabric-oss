/**
 * useConnections Hook
 *
 * Fetches and manages data connections list for the current tenant.
 */

"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toFriendlyPermissionError } from "../lib/permission-error-copy";
import type {
	DataConnectionProvider,
	DataConnectionStatus,
} from "../lib/providers";

interface UseConnectionsOptions {
	provider?: DataConnectionProvider;
	status?: DataConnectionStatus;
}

export function useConnections(options: UseConnectionsOptions = {}) {
	const { organizationId } = useOrganizationContext();

	return useQuery({
		queryKey: [
			"data-connections",
			organizationId,
			options.provider,
			options.status,
		],
		queryFn: async () => {
			const result = await orpcClient.dataConnections.list({
				organizationId: organizationId ?? null,
				provider: options.provider,
				status: options.status,
			});
			return result.connections;
		},
		refetchOnMount: "always",
	});
}

export function useUpdateConnection() {
	const queryClient = useQueryClient();
	const { organizationId } = useOrganizationContext();

	return useMutation({
		mutationFn: async (input: {
			id: string;
			name?: string;
			status?: DataConnectionStatus;
			config?: Record<string, unknown>;
			credentials?: Record<string, unknown>;
			credentialId?: string | null;
		}) => {
			return await orpcClient.dataConnections.update({
				organizationId: organizationId ?? null,
				...input,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["data-connections"] });
		},
		onError: (error) => {
			toast.error(
				toFriendlyPermissionError(error, "Failed to update connection"),
			);
		},
	});
}

export function useDeleteConnection() {
	const queryClient = useQueryClient();
	const { organizationId } = useOrganizationContext();

	return useMutation({
		mutationFn: async (connectionId: string) => {
			return await orpcClient.dataConnections.delete({
				id: connectionId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["data-connections"] });
		},
		onError: (error) => {
			toast.error(
				toFriendlyPermissionError(error, "Failed to delete connection"),
			);
		},
	});
}
