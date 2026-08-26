/**
 * useSyncProgress Hook
 *
 * Fetches sync progress and provides mutations for sync control.
 */

"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toFriendlyPermissionError } from "../lib/permission-error-copy";

interface SyncJob {
	id: string;
	status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
	type: "FULL" | "INCREMENTAL" | "SELECTIVE";
	totalItems: number | null;
	processedItems: number;
	failedItems: number;
	startedAt: Date | null;
	completedAt: Date | null;
	error: string | null;
	createdAt: Date;
}

export function useSyncProgress(connectionId: string | undefined) {
	const { organizationId } = useOrganizationContext();

	return useQuery({
		queryKey: ["sync-progress", connectionId, organizationId],
		queryFn: async () => {
			if (!connectionId) {
				return null;
			}
			const result = await orpcClient.dataConnections.sync.status({
				id: connectionId,
				organizationId: organizationId ?? null,
			});
			return result.syncJobs as SyncJob[];
		},
		enabled: !!connectionId,
		refetchInterval: (query) => {
			// Poll more frequently while syncing
			const data = query.state.data;
			if (data && data.length > 0 && data[0].status === "RUNNING") {
				return 2000; // 2 seconds
			}
			return false; // Don't poll when not running
		},
	});
}

export function useStartSync() {
	const queryClient = useQueryClient();
	const { organizationId } = useOrganizationContext();

	return useMutation({
		mutationFn: async (input: {
			connectionId: string;
			type?: "FULL" | "INCREMENTAL" | "SELECTIVE";
		}) => {
			return await orpcClient.dataConnections.sync.start({
				id: input.connectionId,
				organizationId: organizationId ?? null,
				type: input.type ?? "INCREMENTAL",
			});
		},
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["sync-progress", variables.connectionId],
			});
			queryClient.invalidateQueries({
				queryKey: ["data-connection", variables.connectionId],
			});
			queryClient.invalidateQueries({ queryKey: ["data-connections"] });
		},
		onError: (error) => {
			toast.error(
				toFriendlyPermissionError(error, "Failed to start sync"),
			);
		},
	});
}
