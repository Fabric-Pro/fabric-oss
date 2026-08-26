/**
 * Durable batching for a Fabric-dispatched run (spec F3).
 *
 * ## Why a run is sliced at all
 *
 * A run used to REFUSE more than fifty cases. That pushed the platform's limit
 * onto the user as manual work — "pick 50" — and capped the *feature* rather
 * than the request. Someone who selects a hundred cases wants a hundred cases
 * run; the honest answer is to run them in slices.
 *
 * Slicing needs `continueAsNew`, which bounds workflow history rather than
 * letting it grow with the case count. But **results cannot cross that
 * boundary**: workflow input travels the gRPC transport, and this repo has
 * already been burned by the 4 MiB frame limit (a 6.48 MB activity return was
 * rejected at exactly 4194304 bytes, and raising `blobSize` did NOT help). Step
 * logs for tens of cases would approach it. So only counters and the remaining
 * case ids cross; each slice's detail is STAGED to the database first.
 *
 * ## Why staging exists rather than ingesting per batch
 *
 * `ingestPipelineRun` creates ONE pipeline run per
 * `(projectId, provider, externalRunId)` and is idempotent on it. Calling it per
 * batch with the same id would make every batch after the first either a no-op
 * or a delete-and-recreate, destroying the earlier batches' results. The chosen
 * shape (recorded as Q3) keeps ONE run in the Runs list: batches stage their
 * detail here, and a single reconciling ingest drains it when the last slice
 * finishes.
 */

import {
	listStagedAgenticCaseResults,
	type StagedAgenticCaseResult,
	stageAgenticCaseResults,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { AgenticStepResult, RunAgenticCaseResult } from "./run-case";

/**
 * How many cases one workflow execution runs before continuing as new.
 *
 * Bounds workflow HISTORY, not concurrency — cases still run strictly one at a
 * time, because each launches a real browser on a worker sized for one. Ten is
 * small enough that a slice's history stays modest and large enough that the
 * continue-as-new overhead is not paid per case.
 */
export const AGENTIC_RUN_BATCH_SIZE = 10;

export interface StageAgenticBatchInput {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	runId: string;
	results: RunAgenticCaseResult[];
	/** Human-readable label per case id, for the eventual ingest. */
	caseLabels?: Record<string, string>;
}

/**
 * Activity: persist one slice's per-case results before the workflow continues.
 *
 * This is what makes batching DURABLE rather than merely chunked — after it
 * returns, the slice's work survives the workflow execution that produced it.
 */
export async function stageAgenticBatch(
	input: StageAgenticBatchInput,
): Promise<{ staged: number }> {
	const staged = await stageAgenticCaseResults({
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		runId: input.runId,
		results: input.results.map((r) => ({
			testCaseId: r.testCaseId,
			result: r.result,
			failureMessage: r.failureMessage,
			durationMs: r.durationMs,
			modelCalls: r.modelCalls,
			scriptRevisionId: r.scriptRevisionId ?? null,
			label: input.caseLabels?.[r.testCaseId] ?? null,
			steps: r.steps,
		})),
	});
	logger.info("qa.agentic_run.batch_staged", {
		projectId: input.projectId,
		runId: input.runId,
		cases: input.results.length,
		staged: staged.staged,
	});
	return staged;
}

/**
 * Activity: everything staged for a run, reassembled into the shape the final
 * ingest expects.
 *
 * The labels come back alongside, so the caller does not have to re-read the
 * cases just to name them — and so a case renamed mid-run keeps the name it had
 * when it actually ran.
 */
export async function loadStagedAgenticBatches(input: {
	projectId: string;
	runId: string;
}): Promise<{
	results: RunAgenticCaseResult[];
	caseLabels: Record<string, string>;
}> {
	const staged = await listStagedAgenticCaseResults(input);
	const caseLabels: Record<string, string> = {};
	for (const row of staged) {
		if (row.label) {
			caseLabels[row.testCaseId] = row.label;
		}
	}
	return { results: staged.map(toCaseResult), caseLabels };
}

/**
 * Rebuild a case result from its staged row.
 *
 * `steps` is JSON by the time it comes back, so it is re-shaped defensively: a
 * malformed row must degrade to "no steps recorded" rather than take the whole
 * final ingest down with it, which would lose every OTHER case in the run too.
 */
function toCaseResult(row: StagedAgenticCaseResult): RunAgenticCaseResult {
	return {
		testCaseId: row.testCaseId,
		scriptRevisionId: row.scriptRevisionId ?? null,
		result: row.result,
		failureMessage: row.failureMessage,
		durationMs: row.durationMs,
		modelCalls: row.modelCalls,
		steps: Array.isArray(row.steps)
			? (row.steps as AgenticStepResult[])
			: [],
	};
}
