import type { NativeInstructionBase } from "@saas/projects/lib/instruction-change-source";
import { DEFAULT_FILES } from "@saas/projects/lib/instructions-default-file";
import { instructionsFreshness } from "@saas/projects/lib/instructions-query-freshness";
import { orpc } from "@shared/lib/orpc-query-utils";
import type { QueryClient } from "@tanstack/react-query";

export const loadCodingInstructionsTab = () =>
	import("../CodingInstructionsTab").then((m) => m.CodingInstructionsTab);

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMEMBERED_PIN_KEY_PREFIX = "fabric:coding-instructions:pin:";

/**
 * The commit pin this browser last saw for the project, or null. Only a
 * generation number and a commit hash, no repository content. It is a guess
 * about what `getState` is about to say, never an answer: every read made
 * from it is keyed by that pin, so a branch that has since moved leaves the
 * guess unused and the tab reads the pin `getState` returns.
 */
function readRememberedPin(projectId: string): NativeInstructionBase | null {
	try {
		const raw = window.localStorage.getItem(
			`${REMEMBERED_PIN_KEY_PREFIX}${projectId}`,
		);
		if (raw === null) {
			return null;
		}
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"generation" in parsed &&
			"commitSha" in parsed &&
			typeof parsed.generation === "number" &&
			typeof parsed.commitSha === "string" &&
			COMMIT_SHA.test(parsed.commitSha)
		) {
			return {
				generation: parsed.generation,
				commitSha: parsed.commitSha,
			};
		}
	} catch {
		// Storage can be blocked or hold something else: no guess.
	}
	return null;
}

function rememberPin(projectId: string, pin: NativeInstructionBase): void {
	try {
		window.localStorage.setItem(
			`${REMEMBERED_PIN_KEY_PREFIX}${projectId}`,
			JSON.stringify(pin),
		);
	} catch {
		// Remembering is an optimisation.
	}
}

function startPinnedReads(
	queryClient: QueryClient,
	projectId: string,
	pin: NativeInstructionBase,
): void {
	void prefetchDefaultInstructionFiles(queryClient, projectId, pin);
	void queryClient.prefetchQuery({
		...orpc.projects.instructions.repository.listFiles.queryOptions({
			input: { projectId, ...pin },
		}),
		...instructionsFreshness.pinnedRead,
	});
}

/**
 * Starts what the Coding Instructions tab needs first, before the project
 * and the tab's own code have loaded: the tab's chunk, the repository state
 * that every later read is pinned to, and the file list and the default
 * files at that pin. The page renders the tab only after the project and its
 * gating reads have answered, so none of these waits for them. The reads use
 * the same query options as the tab, so the tab finds them cached or in
 * flight. A failure is left for the tab's own query to report.
 *
 * The pin is only known once `getState` answers, which used to put the file
 * list a whole round trip behind it. When this browser has seen the project
 * before, the reads at the pin it saw start alongside `getState` instead: if
 * the branch has not moved they are the reads the tab needs, already in
 * flight, and if it has, they are an unused read of an older commit and the
 * pin `getState` returns is read as before.
 */
export function warmCodingInstructions(
	queryClient: QueryClient,
	projectId: string,
): void {
	void loadCodingInstructionsTab();
	const remembered = readRememberedPin(projectId);
	if (remembered) {
		startPinnedReads(queryClient, projectId, remembered);
	}
	const stateOptions =
		orpc.projects.instructions.repository.getState.queryOptions({
			input: { projectId },
		});
	void queryClient
		.prefetchQuery(stateOptions)
		.then(() => {
			const state = queryClient.getQueryData(stateOptions.queryKey);
			if (state?.availability !== "READY") {
				return;
			}
			const pin = {
				generation: state.generation,
				commitSha: state.currentCommitSha,
			};
			rememberPin(projectId, pin);
			startPinnedReads(queryClient, projectId, pin);
		})
		.catch(() => undefined);
}

/**
 * The first read of the file the tab opens by default, started as soon as the
 * commit pin is known instead of after the file list has said which of them
 * exists. The candidates are read in preference order and the next one only
 * when the previous came back absent or failed, so a repository with a
 * `CLAUDE.md` pays for one read, not two. A repository without one costs an
 * extra round trip before `AGENTS.md` starts, one cheap "absent" answer. The
 * options match `useInstructionFileContent`'s first page, so the viewer finds
 * the answer cached.
 */
export async function prefetchDefaultInstructionFiles(
	queryClient: QueryClient,
	projectId: string,
	pin: NativeInstructionBase,
): Promise<void> {
	for (const path of DEFAULT_FILES) {
		const file = await queryClient
			.fetchQuery({
				...orpc.projects.instructions.repository.getFile.queryOptions({
					input: {
						projectId,
						...pin,
						path,
						offset: 0,
						maxLength: 200_000,
					},
				}),
				...instructionsFreshness.pinnedRead,
			})
			.catch(() => undefined);
		if (file?.state === "found") {
			return;
		}
	}
}
