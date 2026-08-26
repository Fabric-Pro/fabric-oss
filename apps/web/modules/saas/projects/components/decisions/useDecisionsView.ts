"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

export type DecisionsViewMode = "list" | "table";

function storageKey(projectId: string): string {
	return `adl-view:${projectId}`;
}

function readCache(projectId: string): DecisionsViewMode | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		const v = window.localStorage.getItem(storageKey(projectId));
		return v === "table" || v === "list" ? v : null;
	} catch {
		return null;
	}
}

function writeCache(projectId: string, mode: DecisionsViewMode): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(storageKey(projectId), mode);
	} catch {
		// localStorage unavailable (private mode / quota) — DB is the source of truth.
	}
}

/**
 * Per-user Architecture Decision Log view (list vs table), persisted in the DB
 * per project, with a localStorage cache for an instant first paint before the
 * server preference loads.
 */
export function useDecisionsView(
	projectId: string,
	organizationId?: string | null,
) {
	const queryClient = useQueryClient();

	const { data } = useQuery(
		orpc.projects.architectureDecisions.view.get.queryOptions({
			input: { projectId, organizationId: organizationId ?? null },
		}),
	);

	const serverMode = data?.decisionsView?.mode as
		| DecisionsViewMode
		| undefined;
	const mode: DecisionsViewMode =
		serverMode ?? readCache(projectId) ?? "list";

	const mutation = useMutation(
		orpc.projects.architectureDecisions.view.update.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.architectureDecisions.view.get.queryKey({
							input: {
								projectId,
								organizationId: organizationId ?? null,
							},
						}),
				});
			},
		}),
	);

	const setMode = useCallback(
		(next: DecisionsViewMode) => {
			writeCache(projectId, next);
			mutation.mutate({
				projectId,
				organizationId: organizationId ?? null,
				decisionsView: { mode: next },
			});
		},
		[projectId, organizationId, mutation],
	);

	return { mode, setMode };
}
