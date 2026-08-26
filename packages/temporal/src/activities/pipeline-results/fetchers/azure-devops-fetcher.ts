/**
 * Azure DevOps pipeline-result fetcher. Pulls recent
 * automated Test Runs from a connected ADO project and normalizes them via the
 * shared ADO mapper. Incremental: only runs newer than the stored cursor
 * (highest ingested run id) are fetched, so opening the QA tab never re-pulls
 * the whole history.
 *
 * ADO REST access is injected as {@link AdoClient} so the auth lives outside
 * this fetch: production wires a PAT-authenticated client, a local harness wires
 * `az rest`, and tests mock it. Field shapes were validated against a real ADO
 * Test Run — the list endpoint is a summary (id/state/counts), the detail +
 * results endpoints carry startedDate/completedDate/build + the per-test
 * outcome/name/storage the mapper reads.
 */

import { safeHeartbeat } from "../../lib/activity-liveness";
import type { NormalizedRun } from "../normalized-result";
import {
	type AdoTestResult,
	type AdoTestRun,
	mapAzureDevOpsToNormalizedRuns,
} from "../providers/azure-devops";
import { advanceCursor } from "./cursor";
import { paginateRuns } from "./paginate";

/** Minimal ADO REST access the fetcher needs (GET a path under the org). */
export interface AdoClient {
	get<T = unknown>(path: string): Promise<T>;
}

export interface AdoFetchInput {
	/** ADO project name or id (the connected project). */
	project: string;
	/**
	 * Restrict to Test Runs whose build ran on this branch. ADO's Test Runs list
	 * has no branch filter, so this is applied after the per-run detail fetch —
	 * the only response that carries `buildConfiguration.branchName`. Accepts a
	 * bare name or a full ref; both sides are normalised.
	 */
	branch?: string;
	/** Incremental cursor: only Test Runs with `id` greater than this are pulled. */
	sinceRunId?: number | null;
	/** How many recent runs to scan per fetch (the list is newest-first). */
	maxRuns?: number;
}

export interface AdoFetchResult {
	/** True when the page cap stopped paging before reaching the cursor. */
	truncated?: boolean;
	runs: NormalizedRun[];
	/** Highest run id seen — the caller stores it as the next cursor. */
	newCursor: number | null;
}

interface AdoRunSummary {
	id: number;
	state?: string;
}

/**
 * Fetch + normalize new ADO Test Runs. Lists recent runs (a summary), keeps the
 * COMPLETED ones past the cursor, then pulls each run's detail + results and
 * maps to `NormalizedRun`. Runs are returned oldest-first so ingestion order is
 * chronological and the cursor advances monotonically.
 */
/** `refs/heads/main` and `main` name the same branch. */
function normaliseRef(ref: string | undefined | null): string {
	return (ref ?? "")
		.trim()
		.replace(/^refs\/heads\//, "")
		.toLowerCase();
}

/** No configured branch means take every run, exactly as before. */
function matchesBranch(run: AdoTestRun, branch: string | undefined): boolean {
	if (!branch) {
		return true;
	}
	const runBranch = normaliseRef(run.buildConfiguration?.branchName);
	return !runBranch || runBranch === normaliseRef(branch);
}

export async function fetchAzureDevOpsRuns(
	client: AdoClient,
	input: AdoFetchInput,
): Promise<AdoFetchResult> {
	const top = input.maxRuns ?? 20;
	const project = encodeURIComponent(input.project);
	const since = input.sinceRunId ?? 0;

	// The general test-runs list rejects a wide date window, but a bare $top
	// returns the most recent runs — we filter by the cursor ourselves.
	// Page back to the cursor with $skip: a single $top page against a bigger
	// backlog loses everything below it once the cursor advances.
	const { items: allRuns, truncated } = await paginateRuns<AdoRunSummary>({
		since,
		perPage: top,
		idOf: (r) => r.id,
		onPage: (page) => safeHeartbeat({ phase: "ado-list", page }),
		fetchPage: async (page) => {
			const batch = await client.get<{ value?: AdoRunSummary[] }>(
				`/${project}/_apis/test/runs?api-version=7.1&$top=${top}&$skip=${(page - 1) * top}`,
			);
			return batch.value ?? [];
		},
	});

	// Runs that have NOT completed are kept so `advanceCursor` can hold the
	// cursor below the oldest of them: ids are allocated at run start, so a
	// long run can carry a lower id than a newer run that finishes first, and
	// advancing past it would drop its results permanently.
	const listed = allRuns.filter((r) => r.id > since);
	const isCompleted = (r: AdoRunSummary) =>
		(r.state ?? "").toLowerCase() === "completed";
	const candidates = listed.filter(isCompleted).sort((a, b) => a.id - b.id);
	const pendingIds = listed.filter((r) => !isCompleted(r)).map((r) => r.id);

	const runs: AdoTestRun[] = [];
	const resultsByRunId: Record<string, AdoTestResult[]> = {};
	const ingestedIds: number[] = [];

	for (const c of candidates) {
		// Per-run detail + results calls; check in so a long candidate list
		// cannot outlive the activity heartbeatTimeout.
		safeHeartbeat({ phase: "ado-run", runId: c.id });
		try {
			const detail = await client.get<AdoTestRun>(
				`/${project}/_apis/test/Runs/${c.id}?api-version=7.1`,
			);
			const results = await client.get<{ value?: AdoTestResult[] }>(
				`/${project}/_apis/test/Runs/${c.id}/results?api-version=7.1`,
			);
			if (!matchesBranch(detail, input.branch)) {
				ingestedIds.push(c.id);
				continue;
			}
			runs.push(detail);
			resultsByRunId[String(c.id)] = results.value ?? [];
			ingestedIds.push(c.id);
		} catch (error) {
			pendingIds.push(c.id);
			console.warn("[pipeline-ado] run fetch failed", {
				project: input.project,
				runId: c.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const newCursor = advanceCursor({
		since,
		ingestedIds,
		inFlightIds: pendingIds,
	});

	return {
		runs: mapAzureDevOpsToNormalizedRuns({ runs, resultsByRunId }),
		newCursor: newCursor || null,
		truncated,
	};
}
