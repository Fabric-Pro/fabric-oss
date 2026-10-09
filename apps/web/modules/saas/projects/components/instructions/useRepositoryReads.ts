import type { NativeInstructionBase } from "@saas/projects/lib/instruction-change-source";
import { DEFAULT_FILES } from "@saas/projects/lib/instructions-default-file";
import { instructionsFreshness } from "@saas/projects/lib/instructions-query-freshness";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { prefetchDefaultInstructionFiles } from "./lib/coding-instructions-warmup";

function useDefaultCandidate(
	projectId: string,
	pin: NativeInstructionBase,
	path: string,
	enabled: boolean,
) {
	return useQuery({
		...orpc.projects.instructions.repository.getFile.queryOptions({
			input: {
				projectId,
				generation: pin.generation,
				commitSha: pin.commitSha,
				path,
				offset: 0,
				maxLength: 200_000,
			},
		}),
		...instructionsFreshness.pinnedRead,
		enabled,
	});
}

/**
 * The reads the repository view is made of, all addressed by one commit pin:
 *
 * - the file list;
 * - the default file's body, started as soon as the pin is known and shown
 *   while the list (the slowest read on a large repository) is still coming,
 *   so the first screen never waits for the tree;
 * - the commit list, which only decorates the header and is read once the
 *   list and the default file have loaded, or when History is opened.
 */
export function useRepositoryReads({
	projectId,
	pin,
	readable,
	historyOpen,
}: {
	projectId: string;
	pin: NativeInstructionBase;
	readable: boolean;
	historyOpen: boolean;
}) {
	const queryClient = useQueryClient();
	const { generation, commitSha } = pin;
	useEffect(() => {
		if (readable) {
			void prefetchDefaultInstructionFiles(queryClient, projectId, {
				generation,
				commitSha,
			});
		}
	}, [readable, queryClient, projectId, generation, commitSha]);

	const files = useQuery({
		...orpc.projects.instructions.repository.listFiles.queryOptions({
			input: { projectId, generation, commitSha },
		}),
		...instructionsFreshness.pinnedRead,
		enabled: readable,
	});

	const preferred = useDefaultCandidate(
		projectId,
		pin,
		DEFAULT_FILES[0],
		readable,
	);
	const preferredAbsent =
		preferred.isError ||
		(preferred.data !== undefined && preferred.data.state !== "found");
	const fallback = useDefaultCandidate(
		projectId,
		pin,
		DEFAULT_FILES[1],
		readable && preferredAbsent,
	);
	const candidates = [preferred, fallback];
	let defaultPath: string | null | undefined;
	for (const [index, candidate] of candidates.entries()) {
		if (candidate.data?.state === "found") {
			defaultPath = DEFAULT_FILES[index];
			break;
		}
		if (candidate.data === undefined && !candidate.isError) {
			defaultPath = undefined;
			break;
		}
		defaultPath = null;
	}

	const commits = useQuery({
		...orpc.projects.instructions.repository.listCommits.queryOptions({
			input: { projectId, generation, commitSha, cursor: 1 },
		}),
		...instructionsFreshness.pinnedRead,
		enabled:
			readable &&
			(historyOpen || (files.isSuccess && defaultPath !== undefined)),
	});

	return { files, commits, defaultPath };
}

/**
 * What a commit's re-read must include: the repository state, and the body
 * of the file on screen at the commit that state now names, so the toast that
 * announces the commit never sits over the previous version of the file.
 */
export function useRereadOpenFile({
	projectId,
	path,
	onRefresh,
}: {
	projectId: string;
	path: string | null;
	onRefresh: () => Promise<void>;
}) {
	const queryClient = useQueryClient();
	return async () => {
		await onRefresh();
		const state = queryClient.getQueryData(
			orpc.projects.instructions.repository.getState.queryOptions({
				input: { projectId },
			}).queryKey,
		);
		if (path === null || state?.availability !== "READY") {
			return;
		}
		await queryClient.fetchQuery({
			...orpc.projects.instructions.repository.getFile.queryOptions({
				input: {
					projectId,
					generation: state.generation,
					commitSha: state.currentCommitSha,
					path,
					offset: 0,
					maxLength: 200_000,
				},
			}),
			...instructionsFreshness.pinnedRead,
		});
	};
}
