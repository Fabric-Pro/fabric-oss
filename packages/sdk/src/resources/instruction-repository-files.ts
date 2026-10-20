import type { FabricHttpClient } from "../client.js";

export interface ReadDirectInstructionRepositoryFilesInput {
	generation: number;
	commitSha: string;
	/** One to 200 unique paths; continuation retains the same array. */
	paths: string[];
	startIndex?: number;
}

export interface DirectInstructionRepositoryFilesRead {
	generation: number;
	commitSha: string;
	files: Array<{
		path: string;
		read:
			| { state: "found"; text: string; size: number; textLength: number }
			| { state: "binary"; size: number }
			| { state: "absent" | "tooLarge" };
	}>;
	nextIndex: number | null;
}

/** Read-only POST, with at most two retries and a two-minute total budget. */
export function readPinnedRepositoryFiles(
	http: FabricHttpClient,
	url: string,
	input: ReadDirectInstructionRepositoryFilesInput,
	signal?: AbortSignal,
): Promise<DirectInstructionRepositoryFilesRead> {
	const deadline = AbortSignal.timeout(120_000);
	return http.request<DirectInstructionRepositoryFilesRead>("POST", url, {
		body: input,
		signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
		boundedRead: { maxResponseBytes: 4 * 1024 * 1024 },
	});
}
