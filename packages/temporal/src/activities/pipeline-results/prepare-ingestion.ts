import type {
	IngestPipelineRunInput,
	MatchedPipelineResult,
	PipelineRunTestRecord,
} from "@repo/database";
import {
	type LinkableCase,
	resolveAutomationLink,
} from "@repo/database/prisma/queries/projects/automation-linkage";
import { scrubSecrets } from "@repo/utils/scrub-secrets";
import type { NormalizedRun } from "./normalized-result";
import { mapRawStatusToTestResult } from "./status-mapper";

/**
 * Turn a normalized run + the project's candidate cases into the DB ingest
 * input: match each result to a case via the hybrid linkage cascade, map
 * its raw provider status to a Fabric `TestResult`, and tally run-level counts
 * over ALL results (matched or not). Pure — the ingest activity hands the output
 * straight to `ingestPipelineRun`.
 *
 * This is the seam the four provider fetchers converge on: every provider maps
 * to `NormalizedRun`, and every run is ingested through this one function, so
 * matching + status normalization + counting are defined and tested exactly once.
 *
 * It is also the right place to scrub `failureMessage`. That string is a
 * customer's own test output — a stack trace that can carry a `DATABASE_URL`
 * out of a Prisma exception, or an `Authorization` header dumped by a failed
 * HTTP assertion. From here it fans out three ways: persisted on the run and
 * the finding, copied into a promoted bug's description (which can sync
 * outward to a connected PM tool), and embedded in the root-cause prompt sent
 * to the org's configured third-party model. Scrubbing once at the seam covers
 * all three; scrubbing at any one of them would leave the other two.
 */
export function prepareRunForIngestion(
	run: NormalizedRun,
	cases: LinkableCase[],
	tenant: {
		projectId: string;
		organizationId: string | null;
		userId: string | null;
	},
): IngestPipelineRunInput {
	const matched: MatchedPipelineResult[] = [];
	// Every test, matched or not — denormalized onto the run for the detail view.
	const results: PipelineRunTestRecord[] = [];
	let passedCount = 0;
	let failedCount = 0;
	let skippedCount = 0;
	let otherCount = 0;
	let unmatchedCount = 0;

	for (const r of run.results) {
		const result = mapRawStatusToTestResult(r.rawStatus);
		switch (result) {
			case "PASSED":
				passedCount++;
				break;
			case "FAILED":
				failedCount++;
				break;
			case "SKIPPED":
				// A deliberate skip. This column previously counted NOT_RUN, so
				// the number labelled "skipped" in the UI meant "queued" while
				// real skips hid in otherCount.
				skippedCount++;
				break;
			case "NOT_RUN":
			case "BLOCKED":
				// Queued/never-reached and attempted-but-stuck. Neither is a skip,
				// and neither is a pass or a failure.
				otherCount++;
				break;
			default: {
				// TestResult is a closed enum: a new variant fails to compile here
				// until someone decides which bucket it belongs in, rather than
				// being silently swept into "other".
				const unhandled: never = result;
				throw new Error(`Unhandled TestResult: ${String(unhandled)}`);
			}
		}

		const link = resolveAutomationLink(r, cases);
		if (link) {
			matched.push({
				testCaseId: link.caseId,
				result,
				testName: r.name,
				matchTier: link.tier,
			});
		} else {
			unmatchedCount++;
		}

		results.push({
			name: r.name,
			classname: r.classname ?? null,
			rawStatus: r.rawStatus,
			status: result,
			failureMessage: r.failureMessage
				? scrubSecrets(r.failureMessage)
				: null,
			durationMs: r.durationMs ?? null,
			matchedCaseId: link?.caseId ?? null,
			matchTier: link?.tier ?? null,
		});
	}

	return {
		projectId: tenant.projectId,
		organizationId: tenant.organizationId,
		userId: tenant.userId,
		run: {
			provider: run.provider,
			externalRunId: run.externalRunId,
			pipelineName: run.pipelineName ?? null,
			branch: run.branch ?? null,
			commitSha: run.commitSha ?? null,
			runUrl: run.runUrl ?? null,
			status: run.status ?? null,
			startedAt: run.startedAt ?? null,
			finishedAt: run.finishedAt ?? null,
			durationMs: run.durationMs ?? null,
			triggeredByActor: run.triggeredByActor ?? null,
			triggeredByActorAvatarUrl: run.triggeredByActorAvatarUrl ?? null,
			totalCount: run.results.length,
			passedCount,
			failedCount,
			skippedCount,
			otherCount,
		},
		matched,
		unmatchedCount,
		results,
	};
}
