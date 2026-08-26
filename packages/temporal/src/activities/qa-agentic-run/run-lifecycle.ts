/**
 * The non-browser half of an agentic run: resolving what to run and recording
 * what happened.
 *
 * Both are activities rather than workflow code because both touch the database.
 * Credential decryption stays inside the browser activity and never crosses a
 * replayable workflow boundary.
 *
 * `persistAgenticRun` writes results through {@link ingestPipelineRun} and
 * {@link recordFindingsForRun}, the SAME two helpers CI ingestion uses. That is
 * not an incidental reuse: it is why an agentic failure gets a finding, a
 * fingerprint, per-feature scoping and RCA without one line of code that knows
 * the run came from Fabric rather than from a customer's pipeline.
 */

import {
	AGENTIC_RUN_PROVIDER,
	attachAgenticStepLogs,
	finishAgenticRun,
	getProjectQaSettings,
	ingestPipelineRun,
	listCasesForAgenticRun,
	markAgenticRunStarted,
	recordAgenticCaseProgress,
	recordFindingsForRun,
	resolveAgenticRunActor,
} from "@repo/database";
import { logger } from "@repo/logs";
import { fingerprintFinding } from "../pipeline-results/finding-fingerprint";
import type { RunAgenticCaseInput, RunAgenticCaseResult } from "./run-case";

export interface PrepareAgenticRunInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	runId: string;
	environmentId: string | null;
	targetBaseUrl: string;
	testCaseIds: string[];
	browser: string;
	resolution: string;
	workflowId: string;
	runMode?: "MODE_A" | "MODE_B";
	scriptRevisionIds?: Record<string, string>;
	environmentSnapshot?: {
		signInUrl: string | null;
		authKind: "NONE" | "FORM" | "TOKEN" | "HEADER";
		authUsername: string | null;
		authHeaderName: string | null;
	};
}

export interface PreparedAgenticRun {
	/** Ready-to-run case inputs, one per case that HAS steps. */
	cases: RunAgenticCaseInput[];
	/** Cases asked for that cannot be run, with the reason a human reads. */
	skipped: Array<{ testCaseId: string; reason: string }>;
}

/**
 * Resolve everything the browser activity needs, once per run.
 *
 * Only the environment id crosses the activity boundary. The browser activity
 * resolves and decrypts authentication immediately before use, keeping plaintext
 * credentials out of workflow history and continuation payloads.
 */
export async function prepareAgenticRun(
	input: PrepareAgenticRunInput,
): Promise<PreparedAgenticRun> {
	await markAgenticRunStarted({
		projectId: input.projectId,
		runId: input.runId,
		workflowId: input.workflowId,
	});

	const [settings, cases] = await Promise.all([
		getProjectQaSettings(input.projectId),
		listCasesForAgenticRun({
			projectId: input.projectId,
			testCaseIds: input.testCaseIds,
			runMode: input.runMode,
			scriptRevisionIds: input.scriptRevisionIds,
		}),
	]);

	const houseRules =
		[settings.rulesMarkdown, settings.implementationNotes]
			.filter((v): v is string => !!v?.trim())
			.join("\n\n") || null;

	const runnable = new Set(cases.map((c) => c.id));
	const skipped = input.testCaseIds
		.filter((id) => !runnable.has(id))
		.map((testCaseId) => ({
			testCaseId,
			// Said precisely. "Skipped" with no reason is the thing that makes a
			// coverage number untrustworthy.
			reason:
				input.runMode === "MODE_B"
					? "This case has no saved Playwright script."
					: "This case has no steps, so there was nothing to drive.",
		}));

	return {
		cases: cases.map((c) => ({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			testCaseId: c.id,
			identifier: c.identifier,
			title: c.title,
			description: c.description,
			steps: c.steps.map((s) => ({
				order: s.order,
				action: s.action,
				expected: s.expected,
			})),
			environmentId: input.environmentId,
			targetBaseUrl: input.targetBaseUrl,
			scriptRevisionId: c.scriptRevisionId,
			environmentSnapshot: input.environmentSnapshot,
			browser: input.browser,
			resolution: input.resolution,
			evidencePolicy: settings.evidencePolicy,
			runId: input.runId,
			confidenceThreshold: settings.confidenceThreshold,
			houseRules,
		})),
		skipped,
	};
}

/**
 * Activity: advance the run's counters the moment a case finishes.
 *
 * Deliberately tiny and best-effort at the caller: progress reporting must never
 * be the reason a run fails.
 */
export async function recordAgenticCaseProgressActivity(input: {
	projectId: string;
	runId: string;
	result: "PASSED" | "FAILED" | "BLOCKED" | "NEEDS_REVIEW";
}): Promise<void> {
	await recordAgenticCaseProgress(input);
}

/**
 * The run's terminal status, from what its cases came back with.
 *
 * Extracted and exported for its own tests. It was a five-deep nested ternary at
 * the call site, and the first thing added to it went in wrong: `passed === 0`
 * evaluated before the awaiting-review branch, so a run where EVERY case needed
 * review — the most ordinary way to reach that state — reported BLOCKED and the
 * new status was unreachable except alongside a passing case.
 *
 * Precedence, worst first:
 *  - CANCELLED  a human stopped it; nothing else about the run matters.
 *  - FAILED     the product disagreed with something. A run holding a real
 *               failure is a failed run whatever else it holds.
 *  - BLOCKED    at least one case never reached a verdict, OR nothing was
 *               established at all. A green run over cases that were never
 *               tested says the opposite of what happened — this bit the first
 *               real run, where every case blocked at sign-in and it still
 *               showed PASSED.
 *  - NEEDS_REVIEW  cases ran and the model would not stand behind the verdict.
 *               Above PASSED because a green badge over a verdict nobody trusts
 *               is exactly the claim the confidence threshold exists to stop.
 *  - PASSED     everything else.
 */
export function agenticRunStatusFor(input: {
	cancelled: boolean;
	passed: number;
	failed: number;
	blocked: number;
	needsReview: number;
}): "CANCELLED" | "FAILED" | "BLOCKED" | "NEEDS_REVIEW" | "PASSED" {
	if (input.cancelled) {
		return "CANCELLED";
	}
	if (input.failed > 0) {
		return "FAILED";
	}
	// `passed === 0 && needsReview === 0` is the "nothing was established"
	// catch-all: a run whose cases were all SKIPPED (none had steps) has nothing
	// blocked and nothing failed, and used to come out green while verifying
	// nothing. Awaiting review is explicitly NOT that — those cases ran — so it
	// must be excluded here or it never reaches its own branch below.
	if (input.blocked > 0 || (input.passed === 0 && input.needsReview === 0)) {
		return "BLOCKED";
	}
	if (input.needsReview > 0) {
		return "NEEDS_REVIEW";
	}
	return "PASSED";
}

/**
 * A case verdict in the vocabulary the ingested shape shares with CI-reported
 * runs.
 *
 * `NEEDS_REVIEW` exists only for Fabric's own runner, so it is translated here
 * rather than added to `TestResult` — that enum is also a test case's stored
 * "current result", read by coverage, the traceability matrix and every PM sync,
 * and none of them should have to learn a value only one producer can emit.
 *
 * BLOCKED is the honest neighbour: its documented meaning is "attempted and
 * could not proceed", and a case awaiting review was attempted and reached no
 * verdict. What matters is that it is neither PASSED nor FAILED — the exact
 * claim the confidence threshold exists to withhold. The agentic run beside it
 * keeps the precise state.
 */
function toIngestResult(
	result: "PASSED" | "FAILED" | "BLOCKED" | "NEEDS_REVIEW",
): "PASSED" | "FAILED" | "BLOCKED" {
	return result === "NEEDS_REVIEW" ? "BLOCKED" : result;
}

/**
 * What to CALL a case in the run's results and findings. Falls back to the id,
 * which is what shipped before labels existed.
 */
function caseLabel(
	input: { caseLabels?: Record<string, string> },
	testCaseId: string,
): string {
	return input.caseLabels?.[testCaseId] ?? testCaseId;
}

export interface PersistAgenticRunInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	runId: string;
	targetBaseUrl: string;
	startedAtMs: number;
	results: RunAgenticCaseResult[];
	/**
	 * Human-readable label per case id, e.g. `TC-001 Primary buttons render…`.
	 *
	 * Without it a finding's heading renders as a raw cuid, because the only
	 * per-case identity reaching this activity is the id. CI findings show their
	 * test name, and an agentic finding sat beside them showing
	 * `cmrmp2ow100000i9eyuzasigf` — correct underneath, unreadable on top.
	 *
	 * Optional so a workflow already in flight when this shipped still persists;
	 * it falls back to the id, which is exactly the old behaviour.
	 */
	caseLabels?: Record<string, string>;
	skipped: Array<{ testCaseId: string; reason: string }>;
	/** Estimated dollars per model call — the run's actual bill is derived here. */
	costPerModelCallUsd: number;
	cancelled?: boolean;
	runMode?: "MODE_A" | "MODE_B";
}

export interface PersistAgenticRunResult {
	pipelineRunId: string;
	passed: number;
	failed: number;
	blocked: number;
	needsReview: number;
	findingsCreated: number;
}

/**
 * Record a finished run: one `TestPipelineRun`, one `TestResultEvent` per case,
 * findings for the failures, and the per-step logs.
 */
export async function persistAgenticRun(
	input: PersistAgenticRunInput,
): Promise<PersistAgenticRunResult> {
	const finishedAt = new Date();
	const startedAt = new Date(input.startedAtMs);
	// Resolved rather than carried in the workflow input: a display name can
	// change between dispatch and completion, and workflow input is replayed
	// history — the name a reader sees should be the one that is true now.
	const triggeredByActor = await resolveAgenticRunActor(input.runId);

	const passed = input.results.filter((r) => r.result === "PASSED").length;
	const failed = input.results.filter((r) => r.result === "FAILED").length;
	const blocked = input.results.filter((r) => r.result === "BLOCKED").length;
	const needsReview = input.results.filter(
		(r) => r.result === "NEEDS_REVIEW",
	).length;

	// Every case that ran, plus the ones that could not — the run's own record of
	// what it was asked to cover, so a skipped case is visible rather than absent.
	const perTestRecords = [
		...input.results.map((r) => ({
			name: r.testCaseId,
			classname: null,
			status: toIngestResult(r.result),
			failureMessage: r.failureMessage,
			durationMs: r.durationMs,
			matchedCaseId: r.testCaseId,
			matchTier: null,
			scriptRevisionId: r.scriptRevisionId ?? null,
		})),
		...input.skipped.map((s) => ({
			name: s.testCaseId,
			classname: null,
			status: "SKIPPED" as const,
			failureMessage: s.reason,
			durationMs: null,
			matchedCaseId: s.testCaseId,
			matchTier: null,
			scriptRevisionId: null,
		})),
	];

	const ingest = await ingestPipelineRun({
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		run: {
			provider: AGENTIC_RUN_PROVIDER,
			// The Fabric run id IS the external id. There is no provider to get one
			// from, and using our own keeps the (projectId, provider, externalRunId)
			// uniqueness that makes ingestion idempotent under Temporal retries.
			externalRunId: input.runId,
			pipelineName:
				input.runMode === "MODE_B"
					? "Fabric scripted run"
					: "Fabric agentic run",
			branch: null,
			commitSha: null,
			runUrl: null,
			// Populated so Fabric's own runs are attributed in the shared history
			// the same way a CI-reported run is. Null when the triggering user has
			// been deleted, which renders as no author rather than a dangling id.
			triggeredByActor,
			// The ingested shape is the vocabulary CI-reported runs share, so a
			// run awaiting review lands on `blocked` rather than widening that
			// enum for a concept only Fabric's own runner has. It is the right
			// bucket in that vocabulary anyway — "ran, reached no verdict" — and
			// the agentic run beside it carries the exact state.
			status: input.cancelled
				? "cancelled"
				: failed > 0
					? "failed"
					: blocked > 0 || needsReview > 0
						? "blocked"
						: "passed",
			startedAt,
			finishedAt,
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			totalCount: perTestRecords.length,
			passedCount: passed,
			failedCount: failed,
			skippedCount: input.skipped.length,
			// The ingested shape has four buckets and neither blocked nor
			// awaiting-review is one of them. Both belong in "other" for the same
			// reason: the case ran nothing conclusive, so counting either as passed
			// or failed would state an outcome nobody has.
			otherCount: blocked + needsReview,
		},
		// Every result is matched by construction: an agentic run executes cases
		// Fabric chose, so there is no linkage cascade to run and no unmatched
		// test to report.
		matched: input.results.map((r) => ({
			testCaseId: r.testCaseId,
			result: toIngestResult(r.result),
			scriptRevisionId: r.scriptRevisionId ?? null,
			testName: caseLabel(input, r.testCaseId),
			matchTier: "tag" as const,
		})),
		unmatchedCount: 0,
		results: perTestRecords,
	});

	let findingsCreated = 0;
	const failures = input.results
		.filter((r) => r.result === "FAILED")
		.map((r) => ({
			// Fingerprinted on the case ID ALONE — not the label, and deliberately
			// not the failure message.
			//
			// Not the label, because renaming a case must not orphan its finding
			// history and open a duplicate.
			//
			// Not the message, because for an agentic run it is the MODEL's own
			// prose observation, rewritten on every execution. CI's message is an
			// assertion string, and `normaliseFailureMessage` makes it stable by
			// stripping paths, line numbers and digits — but no normalisation
			// makes two differently-worded English sentences equal. Including it
			// meant a re-run of the same failing case never matched its own prior
			// fingerprint, so the upsert took the CREATE branch every time:
			// duplicate findings without bound, `occurrences` frozen at 1, and
			// "what keeps breaking" unable to show what keeps breaking. Observed
			// on staging 2026-07-27 — three findings from three runs of TC-001
			// failing at the same step on the same expectation.
			//
			// The case IS the identity of an agentic failure. A different fault in
			// the same case is a changed message on one finding, which the update
			// branch already refreshes.
			fingerprint: fingerprintFinding({
				testName: r.testCaseId,
				classname: null,
				failureMessage: null,
			}),
			testName: caseLabel(input, r.testCaseId),
			classname: null,
			failureMessage: r.failureMessage,
			testCaseId: r.testCaseId,
		}));
	if (failures.length > 0) {
		const recorded = await recordFindingsForRun({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			pipelineRunId: ingest.pipelineRunId,
			failures,
		});
		findingsCreated = recorded.created;
	}

	const { attached } = await attachAgenticStepLogs({
		pipelineRunId: ingest.pipelineRunId,
		perCase: input.results.map((r) => ({
			testCaseId: r.testCaseId,
			steps: r.steps.map((s) => ({
				order: s.order,
				action: s.action,
				expected: s.expected,
				status: s.status,
				observation: s.observation,
				evidenceKey: s.evidenceKey,
			})),
		})),
	});

	const modelCalls = input.results.reduce((sum, r) => sum + r.modelCalls, 0);
	await finishAgenticRun({
		projectId: input.projectId,
		runId: input.runId,
		status: agenticRunStatusFor({
			cancelled: input.cancelled === true,
			passed,
			failed,
			blocked,
			needsReview,
		}),
		passedCount: passed,
		failedCount: failed,
		blockedCount: blocked,
		needsReviewCount: needsReview,
		actualCostUsd: modelCalls * input.costPerModelCallUsd,
		pipelineRunId: ingest.pipelineRunId,
	});

	logger.info("qa.agentic_run.persisted", {
		projectId: input.projectId,
		runId: input.runId,
		pipelineRunId: ingest.pipelineRunId,
		passed,
		failed,
		blocked,
		needsReview,
		findingsCreated,
		stepLogsAttached: attached,
		modelCalls,
	});

	return {
		pipelineRunId: ingest.pipelineRunId,
		passed,
		failed,
		blocked,
		needsReview,
		findingsCreated,
	};
}
