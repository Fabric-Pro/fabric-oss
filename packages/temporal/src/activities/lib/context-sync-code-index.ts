/**
 * Living Memory and the code index share a repository: a file the sync keeps
 * in Context (and indexes there) is left out of the code index
 * (`listContextCoveredCodePaths`). When a run changes which files those are,
 * the web app re-runs the code index for exactly them
 * (`/api/internal/code-index/context-paths`).
 *
 * Best effort: the run's own work is done by then, so a failure is logged
 * and the next code index run of the repository settles the files anyway.
 */

import { listContextCoveredCodePaths } from "@repo/database";
import { logger } from "@repo/logs";
import { getFabricInternalBaseUrl } from "../shared/fabric-internal-url";

const REQUEST_TIMEOUT_MS = 30_000;
/**
 * The endpoint's bound. One request per change: a second one would find the
 * first one's run in flight and start nothing. A larger change is left to
 * the repository's next full code index.
 */
const MAX_PATHS_PER_REQUEST = 20_000;

export interface CodeIndexScope {
	projectId: string;
	repositoryIntegrationId: string;
}

/** The files the sync covers now; `null` when the lookup failed. */
export async function coveredCodePaths(
	scope: CodeIndexScope,
): Promise<Set<string> | null> {
	try {
		return await listContextCoveredCodePaths(scope);
	} catch (error) {
		logger.warn(
			`[ContextSync] Could not read the files left out of the code index: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}

/** Paths in one set and not the other. */
export function changedCoverage(
	before: ReadonlySet<string>,
	after: ReadonlySet<string>,
): string[] {
	const changed = [...before].filter((path) => !after.has(path));
	for (const path of after) {
		if (!before.has(path)) {
			changed.push(path);
		}
	}
	return changed.sort();
}

/** Ask the web app to re-run the code index for these paths. Never throws. */
export async function reindexCodeForContextPaths(
	scope: CodeIndexScope,
	paths: string[],
): Promise<void> {
	if (paths.length === 0) {
		return;
	}
	if (paths.length > MAX_PATHS_PER_REQUEST) {
		logger.warn(
			`[ContextSync] ${paths.length} Living Memory files changed, more than one code index update takes; the next full code index settles them`,
		);
		return;
	}
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		logger.warn(
			"[ContextSync] AGENT_SERVICE_SECRET is not configured; the code index is not told about Living Memory files",
		);
		return;
	}
	try {
		const response = await fetch(
			`${getFabricInternalBaseUrl()}/api/internal/code-index/context-paths`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Agent-Service-Token": secret,
				},
				body: JSON.stringify({ ...scope, paths }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
		);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
	} catch (error) {
		logger.warn(
			`[ContextSync] Could not re-run the code index for ${paths.length} Living Memory file(s): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
