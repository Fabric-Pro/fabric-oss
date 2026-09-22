"use client";

/**
 * The retry behind every codebase gate: re-index one repository (Fizzy #1930).
 *
 * Owned by the provider and offered by every banner, rather than supplied by
 * each mount, for the same reason its destinations are: the mounts supplied none, so "Indexing did not finish —
 * run it again" rendered with nothing to press on every surface. The gate names
 * the repository to re-index (`retry.targetId`) — the one whose index failed or
 * never ran — so a multi-repository project does not rebuild the others.
 *
 * A full re-index: an index that failed or never ran has no baseline for an
 * incremental one, and for a stale index "run it again" means exactly that.
 * The re-index supersedes any live run for the same repository, so pressing it
 * cannot start a duplicate.
 */

import type { CapabilityGate } from "@repo/api/modules/capabilities/types";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

export function useCodebaseRetry(projectId: string): {
	/** The retry for this gate, or `undefined` when it is not a codebase one. */
	retryFor: (gate: CapabilityGate) => (() => void) | undefined;
	isRetrying: boolean;
} {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: (args: { projectId: string; integrationId: string }) =>
			orpcClient.projects.repositoryIntegrations.reindex({
				projectId: args.projectId,
				integrationId: args.integrationId,
				mode: "full",
			}),
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Could not start indexing",
			);
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["capability-gates"] });
		},
	});

	const { mutate } = mutation;
	const retryFor = useCallback(
		(gate: CapabilityGate) => {
			const targetId = gate.retry.targetId;
			if (
				projectId === "" ||
				targetId === null ||
				!gate.reasonKey?.startsWith("codebase.")
			) {
				return undefined;
			}
			return () => mutate({ projectId, integrationId: targetId });
		},
		[projectId, mutate],
	);

	return { retryFor, isRetrying: mutation.isPending };
}
