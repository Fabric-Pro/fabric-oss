/**
 * Test Case Draft Workflow
 *
 * Drafts test cases from one or more features, off the request path, so the run
 * survives a page reload, a tab close, and a logout. Started by the `aiDraft`
 * procedure once it has persisted the job row; that row is the durable ledger the
 * UI polls, so this workflow's job is to advance it and stop.
 *
 * Thin + deterministic — all LLM/DB work is in activities, so it is replay-safe.
 * Features are drafted STRICTLY ONE AT A TIME. That is deliberate on two counts:
 * it bounds concurrent LLM spend to a single in-flight generation, and it means
 * the job row has exactly one writer, so appending each outcome needs no locking.
 *
 * Cancelling the run (the user pressed Stop) cancels this workflow. The ledger is
 * already CANCELLED by then; ledger writes are compare-and-set on RUNNING, and
 * the draft activity re-checks the job before billing AND before persisting
 * (returning `null` instead of an outcome), so a cancel mid-generation neither
 * resurrects the run nor appends its cases.
 */

import { proxyActivities } from "@temporalio/workflow";
import type { draftTestCasesForFeature as DraftTestCasesForFeatureFn } from "../activities/test-cases/draft-test-cases-for-feature";
import type {
	beginTestCaseDraftJob as BeginTestCaseDraftJobFn,
	finalizeTestCaseDraftJob as FinalizeTestCaseDraftJobFn,
	recordTestCaseDraftOutcome as RecordTestCaseDraftOutcomeFn,
} from "../activities/test-cases/test-case-draft-job";

/**
 * The billable step: one LLM generation per feature.
 *
 * `maximumAttempts: 1` is the important line. A retry here re-runs the
 * generation and bills for it again, so the default "retry 3×" would let one bad
 * feature cost triple. There is nothing to gain by retrying: the activity already
 * converts every failure it can meet — no provider, no criteria, a rejected or
 * malformed generation — into a recorded outcome rather than a throw, so a throw
 * that reaches Temporal is an infrastructure fault that a 2-second-later retry
 * would hit again. The user retries the run instead, which is a decision they get
 * to make about spending money.
 *
 * Liveness is the heartbeat, not the wall clock, so `startToCloseTimeout` is
 * generous enough for a slow provider without ever being the thing that fails a
 * healthy call.
 */
const { draftTestCasesForFeature } = proxyActivities<{
	draftTestCasesForFeature: typeof DraftTestCasesForFeatureFn;
}>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "60 seconds",
	retry: { maximumAttempts: 1 },
});

/**
 * The ledger bookends. Postgres-only and idempotent (every write is scoped to the
 * status it expects), so unlike the drafting step these retry freely — a blip
 * writing progress must not lose a generation the user already paid for.
 */
const {
	beginTestCaseDraftJob,
	recordTestCaseDraftOutcome,
	finalizeTestCaseDraftJob,
} = proxyActivities<{
	beginTestCaseDraftJob: typeof BeginTestCaseDraftJobFn;
	recordTestCaseDraftOutcome: typeof RecordTestCaseDraftOutcomeFn;
	finalizeTestCaseDraftJob: typeof FinalizeTestCaseDraftJobFn;
}>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface TestCaseDraftWorkflowInput {
	jobId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	storyIds: string[];
}

export async function testCaseDraftWorkflow(
	input: TestCaseDraftWorkflowInput,
): Promise<void> {
	const started = await beginTestCaseDraftJob({ jobId: input.jobId });
	if (!started) {
		// Cancelled before a worker picked it up — spend nothing.
		return;
	}

	for (const storyId of input.storyIds) {
		const outcome = await draftTestCasesForFeature({
			jobId: input.jobId,
			projectId: input.projectId,
			storyId,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		// `null` = the activity found the job no longer RUNNING (cancelled) and
		// persisted nothing. There is no outcome to record and no next feature
		// to pay for — the run is over.
		if (outcome === null) {
			return;
		}

		const stillRunning = await recordTestCaseDraftOutcome({
			jobId: input.jobId,
			outcome,
		});
		// The ledger says the run is no longer live (cancelled mid-flight). Stop
		// before paying for the next feature.
		if (!stillRunning) {
			return;
		}
	}

	await finalizeTestCaseDraftJob({
		jobId: input.jobId,
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
	});
}
