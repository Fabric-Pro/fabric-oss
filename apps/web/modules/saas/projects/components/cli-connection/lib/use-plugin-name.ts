"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";

/**
 * The project's plugin name as Fabric holds it (its own setting, or its name
 * as a slug), for the dialog's install and `/mcp` hints. Until it loads, or
 * where the read is not available, the project's name as a slug stands in.
 */
export function usePluginName(
	projectId: string,
	projectName?: string | null,
): string | null {
	const procedure = (
		orpc as unknown as {
			projects?: {
				instructions?: {
					getPluginName?: typeof orpc.projects.instructions.getPluginName;
				};
			};
		}
	).projects?.instructions?.getPluginName;
	const query = useQuery(
		procedure
			? {
					...procedure.queryOptions({ input: { projectId } }),
					retry: false,
				}
			: {
					queryKey: ["plugin-name-unavailable", projectId],
					queryFn: async () => null,
					enabled: false,
				},
	);
	const data = query.data as { name?: string } | null | undefined;
	return data?.name ?? projectName ?? null;
}
