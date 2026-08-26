import {
	ingestPipelineRun,
	listLinkableCases,
	markDocumentsPendingDeploy,
	recordFindingsForRun,
} from "@repo/database";
import { safeHeartbeat } from "../lib/activity-liveness";
import { fingerprintFinding } from "./finding-fingerprint";
import type { NormalizedRun } from "./normalized-result";
import { prepareRunForIngestion } from "./prepare-ingestion";

export interface IngestNormalizedRunsInput {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	runs: NormalizedRun[];
	/**
	 * The branch a successful run on counts as a deployment. Absent disables
	 * deploy detection entirely — no branch, no deploy.
	 */
	deployBranch?: string | null;
}

/**
 * Run-level statuses that mean "this pipeline succeeded".
 *
 * An explicit allow-list, and unrecognised means NOT a deploy. The failure modes
 * are asymmetric: missing a deploy delays a document refresh until the next one,
 * while inventing one spends a customer's model budget rewriting a document
 * because a build went red.
 */
const DEPLOY_SUCCESS_STATUSES = new Set([
	"success",
	"succeeded",
	"passed",
	"completed",
]);

/** Whether an ingested run looks like a deployment of `deployBranch`. */
function looksLikeDeploy(
	run: NormalizedRun,
	deployBranch: string | null | undefined,
): boolean {
	if (!deployBranch || !run.branch || !run.status) {
		return false;
	}
	// Branch names arrive as `refs/heads/main` from some providers and `main`
	// from others; compare on the trailing segment so both agree.
	const tail = (b: string) => b.split("/").pop()?.toLowerCase() ?? "";
	if (tail(run.branch) !== tail(deployBranch)) {
		return false;
	}
	return DEPLOY_SUCCESS_STATUSES.has(run.status.trim().toLowerCase());
}

export interface IngestNormalizedRunsResult {
	/** ON_DEPLOY documents marked due because this sync saw a deployment. */
	documentsMarkedForDeploy: number;
	/** Runs newly persisted this call. */
	ingestedRuns: number;
	/** Runs already ingested (idempotent no-ops). */
	skippedRuns: number;
	/** Per-case results matched to a case across all newly-ingested runs. */
	matched: number;
	/** Results that matched no case (surfaced so the UI can flag coverage gaps). */
	unmatched: number;
	/**
	 * Deduped ids of every case a newly-ingested run touched — the RCA→BUG input.
	 * The caller re-reads each case's current denormalized result and opens bugs
	 * for those now FAILED (so a case that later passed isn't flagged).
	 */
	touchedCaseIds: string[];
	/** Distinct failures seen for the first time in this project. */
	findingsCreated: number;
	/** Known failures that recurred (their occurrence count went up). */
	findingsUpdated: number;
}

/**
 * Activity: ingest a batch of normalized runs. Loads the project's
 * candidate cases once, then prepares (match + status-map + count) and persists
 * each run through the idempotent {@link ingestPipelineRun}. Provider-agnostic —
 * every fetcher hands its runs here as `NormalizedRun[]`.
 */
export async function ingestNormalizedRuns(
	input: IngestNormalizedRunsInput,
): Promise<IngestNormalizedRunsResult> {
	const cases = await listLinkableCases({
		projectId: input.projectId,
	});

	let ingestedRuns = 0;
	let skippedRuns = 0;
	let matched = 0;
	let unmatched = 0;
	const deployRuns: string[] = [];
	let findingsCreated = 0;
	let findingsUpdated = 0;
	const touched = new Set<string>();

	for (const run of input.runs) {
		// Ingest is the long half of the sync: a transaction plus the linkage
		// cascade over every result in the run. The fetchers check in per run,
		// this loop did not, so a big enough batch could outlive the activity's
		// 30s heartbeatTimeout and be killed mid-flight while healthy — the
		// cursor then never advanced and the retry did the same work again.
		safeHeartbeat({
			phase: "pipeline-ingest",
			provider: run.provider,
			externalRunId: run.externalRunId,
		});
		const prepared = prepareRunForIngestion(run, cases, {
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
		});
		// Collect the cases this run links to from the PREPARED matches, not the
		// ingest result — so a run that's an idempotent no-op on a retry (already
		// ingested) still contributes its cases to RCA. Otherwise a retry after a
		// mid-sync failure would re-see the run as "already ingested", return no
		// cases, and never open the bug for a still-failing case.
		for (const m of prepared.matched) {
			touched.add(m.testCaseId);
		}
		const res = await ingestPipelineRun(prepared);
		if (res.alreadyIngested) {
			skippedRuns++;
		} else {
			ingestedRuns++;
			if (looksLikeDeploy(run, input.deployBranch)) {
				deployRuns.push(run.externalRunId);
			}
			matched += res.matched;
			unmatched += res.unmatched;

			// Record the run's distinct failures as findings. Only for a run we
			// actually ingested: an idempotent re-fetch of the same run must not
			// inflate `occurrences`, which is meant to count how often the fault
			// RECURRED, not how often we happened to sync.
			//
			// Built from `prepared.results` — every failing test, matched to a case
			// or not. The unmatched ones are the point: a failure in a test Fabric
			// tracks no case for is invisible in the case-centric view today, and
			// it is exactly the kind worth surfacing.
			const failures = (prepared.results ?? [])
				.filter((r) => r.status === "FAILED")
				.map((r) => ({
					fingerprint: fingerprintFinding({
						testName: r.name,
						classname: r.classname,
						failureMessage: r.failureMessage,
					}),
					testName: r.name,
					classname: r.classname ?? null,
					failureMessage: r.failureMessage ?? null,
					testCaseId: r.matchedCaseId ?? null,
				}));
			if (failures.length > 0) {
				const recorded = await recordFindingsForRun({
					projectId: input.projectId,
					organizationId: input.organizationId,
					userId: input.userId,
					pipelineRunId: res.pipelineRunId,
					failures,
				});
				findingsCreated += recorded.created;
				findingsUpdated += recorded.updated;
			}
		}
	}

	// A deployment marks every ON_DEPLOY-enrolled document in the project as due
	// and stops there. The hourly sweep does the actual refresh, so the
	// collision, stale-actor and tenant guards all still apply — see
	// `markDocumentsPendingDeploy`.
	//
	// Only NEWLY ingested runs count: re-reading an already-ingested run on a
	// retry is not a new deployment, and treating it as one would re-trigger a
	// refresh every sync.
	let documentsMarkedForDeploy = 0;
	if (deployRuns.length > 0) {
		documentsMarkedForDeploy = await markDocumentsPendingDeploy({
			projectId: input.projectId,
			at: new Date(),
		});
	}

	return {
		documentsMarkedForDeploy,
		ingestedRuns,
		skippedRuns,
		matched,
		unmatched,
		touchedCaseIds: Array.from(touched),
		findingsCreated,
		findingsUpdated,
	};
}
