import type { NativeInstructionBase } from "@saas/projects/lib/instruction-change-source";
import { DEFAULT_FILES } from "@saas/projects/lib/instructions-default-file";
import { orpc } from "@shared/lib/orpc-query-utils";
import type { QueryClient } from "@tanstack/react-query";

export const loadCodingInstructionsTab = () =>
	import("../CodingInstructionsTab").then((m) => m.CodingInstructionsTab);

/**
 * Starts what the Coding Instructions tab needs first, before the project
 * and the tab's own code have loaded: the tab's chunk and the repository
 * state that every later read is pinned to. The state read uses the same
 * query options as the tab, so the tab finds it already cached or in flight.
 * A failure is left for the tab's own query to report.
 */
export function warmCodingInstructions(
	queryClient: QueryClient,
	projectId: string,
): void {
	void loadCodingInstructionsTab();
	void queryClient.prefetchQuery(
		orpc.projects.instructions.repository.getState.queryOptions({
			input: { projectId },
		}),
	);
}

/**
 * The first read of each file the tab may open by default, started as soon as
 * the commit pin is known instead of after the file list has said which of
 * them exists. The options match `useInstructionFileContent`'s first page, so
 * the viewer finds the answer cached. A candidate the repository lacks costs
 * one cheap "absent" answer and the list then picks the real default as before.
 */
export function prefetchDefaultInstructionFiles(
	queryClient: QueryClient,
	projectId: string,
	pin: NativeInstructionBase,
): void {
	for (const path of DEFAULT_FILES) {
		void queryClient.prefetchQuery({
			...orpc.projects.instructions.repository.getFile.queryOptions({
				input: {
					projectId,
					...pin,
					path,
					offset: 0,
					maxLength: 200_000,
				},
			}),
			staleTime: Number.POSITIVE_INFINITY,
		});
	}
}
