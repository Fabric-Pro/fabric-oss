/**
 * Workflow: run a set of Fabric-authored test cases against a live environment.
 *
 * Cases run ONE AT A TIME, on purpose. Each one launches a real browser on the
 * worker, and a run of twenty cases fanned out in parallel is twenty concurrent
 * Chromium processes on a container sized for neither the memory nor the CPU.
 * Sequential is also what makes the cost cap meaningful: the run can stop the
 * moment cancellation arrives rather than after everything in flight drains.
 *
 * The workflow never touches the database or a credential directly — both live
 * in activities. Workflow code is replayed, and a decrypted secret in replayable
 * history would outlive every rotation.
 */

import {
	continueAsNew,
	defineSignal,
	patched,
	proxyActivities,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type { RunAgenticCaseResult } from "../activities/qa-agentic-run/run-case";

/**
 * Per-case timeout. A case is up to {@link MAX_OPERATIONS_PER_CASE} operations,
 * each a browser action plus two model calls, so ten minutes is generous for a
 * healthy case and still bounded for a pathological one.
 */
const { runAgenticCase } = proxyActivities<typeof activities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "2 minutes",
	// A browser that will not launch fails the same way every time. One retry
	// covers a genuine blip; more just spends ten more minutes reaching the same
	// answer. `runAgenticCase` already returns BLOCKED rather than throwing for
	// everything it can describe, so a throw here really is exceptional.
	retry: { maximumAttempts: 2 },
});

const { runScriptedCase } = proxyActivities<typeof activities>({
	startToCloseTimeout: "6 minutes",
	retry: { maximumAttempts: 1 },
});

const {
	prepareAgenticRun,
	persistAgenticRun,
	recordAgenticCaseProgressActivity,
	stageAgenticBatch,
	loadStagedAgenticBatches,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	retry: { maximumAttempts: 3 },
});

/**
 * Cases run per workflow execution before continuing as new (spec F3).
 *
 * Restated here rather than imported from the activities module: workflow code
 * is bundled separately and must not pull in an activity's dependency graph. The
 * activity module exports the same number under `AGENTIC_RUN_BATCH_SIZE`, and a
 * test asserts the two agree.
 */
export const WORKFLOW_BATCH_SIZE = 10;

/**
 * The most specific message in a thrown error's cause chain.
 *
 * A failing activity reaches the workflow as an `ActivityFailure` whose own
 * message is the fixed string "Activity task failed" — the real reason is nested
 * one or two levels down in `cause`. Reading only the outer message turned every
 * runner failure into the same unactionable line: a blocked run reported
 * "The runner failed: ActivityFailure: Activity task failed" whether the sandbox
 * was unreachable, a credential was missing, or the target URL was refused.
 *
 * Walks to the deepest cause carrying a non-empty message, so the reason that
 * actually explains the failure is the one the reader sees. Bounded, because a
 * cause chain can in principle be circular.
 */
export function rootCauseMessage(err: unknown): string {
	let current = err;
	let best: string | null = null;
	for (let depth = 0; depth < 8 && current != null; depth++) {
		const message =
			current instanceof Error ? current.message : String(current);
		// Temporal's wrapper messages say nothing a reader can act on, so they
		// never win over a cause that does.
		if (message && !/^Activity task failed\.?$/i.test(message)) {
			best = message;
		}
		current = current instanceof Error ? current.cause : undefined;
	}
	return best ?? String(err);
}

/**
 * Temporal patch id for durable batching.
 *
 * Runs that started before batching scheduled `persistAgenticRun` where this
 * code now commands `stageAgenticBatch`. Replaying them without a patch fails
 * with `[TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'persistAgenticRun' does not match activity type of activity command
 * 'stageAgenticBatch'` — which is exactly what CI's replay validation caught
 * against ten closed histories.
 *
 * `patched()` returns false when replaying those, so they take the original
 * single-pass path and stay replayable; new executions get batching. Removable
 * once no history predating it is still retained.
 */
const BATCHING_PATCH_ID = "qa-agentic-durable-batching";

export const cancelAgenticRunSignal = defineSignal("cancelAgenticRun");

export interface QaAgenticRunWorkflowInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	runId: string;
	environmentId: string | null;
	targetBaseUrl: string;
	testCaseIds: string[];
	browser: string;
	resolution: string;
	costPerModelCallUsd: number;
	/** MODE_A drives authored steps with AI; MODE_B runs the saved sandbox script. */
	runMode?: "MODE_A" | "MODE_B";
	/** Immutable case-script selections made before workflow dispatch. */
	scriptRevisionIds?: Record<string, string>;
	/** Non-secret environment fields snapshotted with the run. */
	environmentSnapshot?: {
		signInUrl: string | null;
		authKind: "NONE" | "FORM" | "TOKEN" | "HEADER";
		authUsername: string | null;
		authHeaderName: string | null;
	};
	/**
	 * Cases still to run, when this execution is a CONTINUATION (spec F3).
	 *
	 * Absent on the first execution, where `testCaseIds` is the whole request.
	 * Only ids and counters cross a `continueAsNew` boundary: results cannot,
	 * because workflow input travels the gRPC transport and this repo has already
	 * been burned by the 4 MiB frame limit. Each slice's detail is staged to the
	 * database before continuing.
	 */
	remainingCaseIds?: string[];
	/** Cases reported skipped by earlier slices, carried so the final run reports them. */
	carriedSkipped?: Array<{ testCaseId: string; reason: string }>;
	/** Wall-clock start of the FIRST slice, so the run's duration is the whole run. */
	carriedStartedAtMs?: number;
	/** Cancellation survives the boundary — otherwise a continue would resume a cancelled run. */
	carriedCancelled?: boolean;
}

export async function qaAgenticRunWorkflow(
	input: QaAgenticRunWorkflowInput,
): Promise<{
	pipelineRunId: string;
	passed: number;
	failed: number;
	blocked: number;
	needsReview: number;
}> {
	let cancelled = false;
	setHandler(cancelAgenticRunSignal, () => {
		// Cooperative: the loop checks between cases. Nothing is torn out from
		// under a browser mid-case, so the steps that already ran are still
		// recorded — a cancelled run with partial results is far more useful
		// than a cancelled run with none.
		cancelled = true;
	});

	// The FIRST slice's clock, carried across every continuation so the run's
	// duration is the whole run rather than its last slice.
	const startedAtMs = input.carriedStartedAtMs ?? Date.now();
	if (input.carriedCancelled) {
		cancelled = true;
	}

	// Called unconditionally and once, before any branch reads it: `patched` is
	// itself a workflow command, so a conditional call would be the very
	// non-determinism it exists to prevent.
	const batching = patched(BATCHING_PATCH_ID);

	// A continuation runs only what is left; the first execution runs the request.
	// Without batching this is the whole selection in one pass, which is what
	// pre-patch histories recorded.
	const pendingCaseIds = input.remainingCaseIds ?? input.testCaseIds;
	const sliceCaseIds = batching
		? pendingCaseIds.slice(0, WORKFLOW_BATCH_SIZE)
		: pendingCaseIds;
	const afterSliceCaseIds = batching
		? pendingCaseIds.slice(WORKFLOW_BATCH_SIZE)
		: [];

	const prepared = await prepareAgenticRun({
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		runId: input.runId,
		environmentId: input.environmentId,
		targetBaseUrl: input.targetBaseUrl,
		// Only this slice's cases are prepared, keeping the continuation payload
		// bounded. Credentials are resolved later inside each browser activity.
		testCaseIds: sliceCaseIds,
		browser: input.browser,
		resolution: input.resolution,
		workflowId: workflowInfo().workflowId,
		...(input.runMode ? { runMode: input.runMode } : {}),
		...(input.scriptRevisionIds
			? { scriptRevisionIds: input.scriptRevisionIds }
			: {}),
		...(input.environmentSnapshot
			? { environmentSnapshot: input.environmentSnapshot }
			: {}),
	});

	const carriedSkipped = input.carriedSkipped ?? [];

	if (prepared.cases.length === 0 && afterSliceCaseIds.length === 0) {
		// Nothing runnable and nothing left. Still persisted, so the run shows why
		// rather than vanishing — every case is reported skipped with its reason.
		// Earlier slices' detail is drained from staging so a run whose LAST slice
		// happened to be empty still reports everything that did run. A pre-patch
		// history never staged anything, so it must not command that read.
		const staged = batching
			? await loadStagedAgenticBatches({
					projectId: input.projectId,
					runId: input.runId,
				})
			: { results: [], caseLabels: {} as Record<string, string> };
		return await persistAgenticRun({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			runId: input.runId,
			targetBaseUrl: input.targetBaseUrl,
			startedAtMs,
			results: staged.results,
			caseLabels: staged.caseLabels,
			skipped: [...carriedSkipped, ...prepared.skipped],
			costPerModelCallUsd: input.costPerModelCallUsd,
			cancelled,
			...(input.runMode ? { runMode: input.runMode } : {}),
		});
	}

	const results: RunAgenticCaseResult[] = [];
	const skipped = [...carriedSkipped, ...prepared.skipped];

	for (const caseInput of prepared.cases) {
		if (cancelled) {
			skipped.push({
				testCaseId: caseInput.testCaseId,
				reason: "The run was cancelled before this case started.",
			});
			continue;
		}
		try {
			const caseResult =
				input.runMode === "MODE_B"
					? await runScriptedCase({
							projectId: caseInput.projectId,
							organizationId: caseInput.organizationId,
							userId: caseInput.userId,
							testCaseId: caseInput.testCaseId,
							scriptRevisionId:
								caseInput.scriptRevisionId ??
								input.scriptRevisionIds?.[
									caseInput.testCaseId
								] ??
								"",
							environmentId: caseInput.environmentId ?? null,
							targetBaseUrl: caseInput.targetBaseUrl,
							...(caseInput.environmentSnapshot
								? {
										environmentSnapshot:
											caseInput.environmentSnapshot,
									}
								: {}),
							browser: caseInput.browser,
							resolution: caseInput.resolution,
						})
					: await runAgenticCase(caseInput);
			results.push(caseResult);
			// Advance the run's counters NOW, not at the end. Without this the
			// counts sat at zero for the whole run and then jumped to final —
			// a progress UI polling a backend that only reported once.
			//
			// Best-effort: progress reporting must never be the reason a run
			// fails, so a failure here is swallowed and the authoritative totals
			// are written by `persistAgenticRun` regardless.
			try {
				await recordAgenticCaseProgressActivity({
					projectId: input.projectId,
					runId: input.runId,
					result: caseResult.result,
				});
			} catch {
				// Deliberately ignored — see above.
			}
		} catch (err) {
			// The activity exhausted its retries. Recorded as a blocked case so
			// the run still completes and reports the other cases honestly.
			results.push({
				testCaseId: caseInput.testCaseId,
				scriptRevisionId: caseInput.scriptRevisionId ?? null,
				result: "BLOCKED",
				failureMessage: `The runner failed: ${rootCauseMessage(err)}`,
				durationMs: 0,
				steps: [],
				modelCalls: 0,
			});
		}
	}

	// This slice's labels. Built here because this is the only place holding both
	// the ids and the cases they came from; they are staged with the results so
	// the final ingest can name findings without re-reading the cases.
	const sliceLabels = Object.fromEntries(
		prepared.cases.map((c) => [c.testCaseId, `${c.identifier} ${c.title}`]),
	);

	if (!batching) {
		// The original single-pass path, preserved verbatim for histories that
		// predate the patch: every prepared case ran in this execution, and its
		// results go straight to the one persist call they recorded.
		return persistAgenticRun({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			runId: input.runId,
			targetBaseUrl: input.targetBaseUrl,
			startedAtMs,
			results,
			caseLabels: sliceLabels,
			skipped,
			costPerModelCallUsd: input.costPerModelCallUsd,
			cancelled,
			...(input.runMode ? { runMode: input.runMode } : {}),
		});
	}

	// STAGE before continuing. This is what makes batching durable rather than
	// merely chunked: after this returns, the slice's work survives the workflow
	// execution that produced it, and nothing large has to cross the
	// continue-as-new boundary.
	await stageAgenticBatch({
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		runId: input.runId,
		results,
		caseLabels: sliceLabels,
	});

	// More to do, and not cancelled: hand the remainder to a fresh execution so
	// history stays bounded however many cases were requested. Cancellation is
	// carried explicitly — without it a continuation would cheerfully resume a
	// run somebody stopped.
	if (afterSliceCaseIds.length > 0 && !cancelled) {
		await continueAsNew<typeof qaAgenticRunWorkflow>({
			...input,
			remainingCaseIds: afterSliceCaseIds,
			carriedSkipped: skipped,
			carriedStartedAtMs: startedAtMs,
			carriedCancelled: cancelled,
		});
	}

	// Last slice (or cancelled). Drain everything every slice staged and ingest
	// it ONCE, so the Runs list still shows a single run per dispatch rather than
	// one row per batch.
	const staged = await loadStagedAgenticBatches({
		projectId: input.projectId,
		runId: input.runId,
	});

	// A cancelled run still reports the cases it never reached, so "cancelled
	// after 12 of 100" is legible rather than looking like a 12-case run.
	const unreached = cancelled
		? afterSliceCaseIds.map((testCaseId) => ({
				testCaseId,
				reason: "The run was cancelled before this case started.",
			}))
		: [];

	return persistAgenticRun({
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		runId: input.runId,
		targetBaseUrl: input.targetBaseUrl,
		startedAtMs,
		results: staged.results,
		caseLabels: staged.caseLabels,
		skipped: [...skipped, ...unreached],
		costPerModelCallUsd: input.costPerModelCallUsd,
		cancelled,
		...(input.runMode ? { runMode: input.runMode } : {}),
	});
}
