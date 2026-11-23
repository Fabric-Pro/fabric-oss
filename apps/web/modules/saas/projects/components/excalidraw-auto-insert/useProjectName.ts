"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";

interface UseProjectNameOptions {
	projectId: string | null;
	organizationId: string | null;
	/** The name the caller already knows; no lookup runs when it is set. */
	knownName?: string | null;
	/** Look the name up only while it is about to be shown. */
	enabled: boolean;
}

/**
 * Resolves a project's display name for auto-insert copy, so a raw project
 * id never reaches the user. Returns null until a name is known; callers
 * fall back to "this project".
 */
export function useProjectName({
	projectId,
	organizationId,
	knownName,
	enabled,
}: UseProjectNameOptions): string | null {
	const projectQuery = useQuery({
		...orpc.projects.get.queryOptions({
			input: { id: projectId ?? "", organizationId },
		}),
		enabled: enabled && !knownName && !!projectId,
	});
	return knownName || projectQuery.data?.project.name || null;
}
