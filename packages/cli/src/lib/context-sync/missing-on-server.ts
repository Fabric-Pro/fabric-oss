/**
 * Which files a push did not send because its lock records them as pushed, yet
 * the server no longer holds: a Living Memory reset, including one that landed
 * while a push was running, or a teammate's delete.
 *
 * It only reads, and it never stops a push. A request that fails, including on
 * a server older than the route, keeps what the earlier ones learned and marks
 * the answer incomplete, so the report never reads as if the files were checked.
 *
 * The files are reported and not sent again: a file someone deleted on purpose
 * must not come back because a folder still holds a copy.
 */
import type { FabricClient } from "@fabricorg/sdk";
import type { ContextLock } from "./lock.js";

/** The route's own bound on one request. */
const PATHS_PER_REQUEST = 500;

export interface MissingOnServer {
	paths: readonly string[];
	/** A request failed, so some files were not checked. */
	incomplete: boolean;
}

/** What a run that did not check has to say about it: nothing. */
export const NOTHING_MISSING: MissingOnServer = {
	paths: [],
	incomplete: false,
};

export async function findMissingOnServer(input: {
	client: {
		contexts: Pick<FabricClient["contexts"], "findMissingSyncedFiles">;
	};
	projectId: string;
	org?: string;
	lock: ContextLock | null;
	/** The paths the plan found unchanged against the lock. */
	unchanged: readonly string[];
}): Promise<MissingOnServer> {
	// A duplicate never had a row of its own, so it has none to lose.
	const confirmed = input.unchanged.filter(
		(sourcePath) => input.lock?.files[sourcePath]?.state !== "duplicate",
	);
	const paths: string[] = [];
	try {
		for (let i = 0; i < confirmed.length; i += PATHS_PER_REQUEST) {
			const answer = await input.client.contexts.findMissingSyncedFiles(
				input.projectId,
				confirmed.slice(i, i + PATHS_PER_REQUEST),
				{ org: input.org },
			);
			paths.push(...answer.missing);
		}
	} catch {
		return { paths, incomplete: true };
	}
	return { paths, incomplete: false };
}
