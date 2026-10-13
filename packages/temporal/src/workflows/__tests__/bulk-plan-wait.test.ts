/**
 * Bulk runs a person starts wait for a shared ChatGPT plan's reset instead of
 * failing (Fizzy #2770), in the real workflows: when every shared plan is
 * spent under a "Wait for reset" policy, the step that hit the limit waits on
 * a durable timer and resumes — the finished part of a fan-out is kept, never
 * redone. Under an AUTO policy the estimate is zero, so the step retries at
 * once (and resolves to the organization's provider) with no timer.
 *
 * The workflows run in a time-skipping environment with stubbed activities,
 * started with the execution timeouts their API starters set.
 */

import { resolve } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WORKFLOWS = resolve(__dirname, "..");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let env: TestWorkflowEnvironment;
let grouping: WorkflowBundleWithSourceMap;
let review: WorkflowBundleWithSourceMap;
let scan: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	[grouping, review, scan] = await Promise.all(
		[
			"security-finding-grouping.ts",
			"scan-finding-review.ts",
			"security-accessibility-scan.ts",
		].map((file) =>
			bundleWorkflowCode({ workflowsPath: resolve(WORKFLOWS, file) }),
		),
	);
}, 300_000);

afterAll(async () => {
	await env?.teardown();
});

const spent = (details?: unknown) =>
	ApplicationFailure.create({
		message:
			"Every ChatGPT plan this work may use has no usage left in this window.",
		type: "SubscriptionPlanExhaustedError",
		nonRetryable: true,
		...(details !== undefined && { details: [details] }),
	});

interface RunOptions {
	bundle: WorkflowBundleWithSourceMap;
	workflowType: string;
	input: unknown;
	executionTimeoutMs: number;
	activities: Record<string, (...args: never[]) => Promise<unknown>>;
	/** What the reset estimate answers: zero is an AUTO policy. */
	waitMs: number;
}

async function run(options: RunOptions) {
	const taskQueue = `bulk-plan-wait-${++taskQueueSeq}`;
	const estimates: unknown[] = [];
	const pauses: Array<Record<string, unknown>> = [];
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: options.bundle,
		activities: {
			...options.activities,
			estimatePlanPoolResetActivity: async (input: unknown) => {
				estimates.push(input);
				return {
					waitMs: options.waitMs,
					jitterMs: 0,
					resetKnown: true,
				};
			},
			// A wait past the run's pause threshold or deadline pauses it
			// (Fizzy #2770); the pause's own effects are pinned in
			// bulk-run-pause.test.ts.
			pauseBulkRunActivity: async (input: Record<string, unknown>) => {
				pauses.push(input);
				return {
					paused: true,
					resumesAt: "2026-10-12T15:00:00.000Z",
					pauseCount: 1,
				};
			},
		},
	});
	const handle = await env.client.workflow.start(options.workflowType, {
		taskQueue,
		workflowId: `${taskQueue}-wf`,
		args: [options.input],
		workflowExecutionTimeout: options.executionTimeoutMs,
	});
	const startedAt = await env.currentTimeMs();
	const output = await worker.runUntil(handle.result());
	const elapsedMs = (await env.currentTimeMs()) - startedAt;
	const history = await handle.fetchHistory();
	const timers =
		history.events?.filter((event) => event.timerStartedEventAttributes)
			.length ?? 0;
	return { output, estimates, elapsedMs, timers, pauses };
}

// =============================================================================
// Group into tickets: the spent theme waits and is drafted again; the themes
// already drafted are kept.
// =============================================================================

describe("securityFindingGroupingWorkflow", () => {
	const theme = (themeKey: string) => ({
		category: "SECURITY",
		ruleSource: themeKey,
		severity: null,
		themeKey,
		declined: false,
		findings: [{ id: `finding-${themeKey}`, fingerprint: themeKey }],
	});
	const proposal = (themeKey: string) => ({
		outcome: "create",
		proposal: {
			category: "SECURITY",
			ruleSource: themeKey,
			themeKey,
			findingCount: 1,
			severity: null,
			title: `[Security] ${themeKey}`,
			body: "Body",
			priority: "HIGH",
			fingerprints: [themeKey],
		},
		modelName: "model",
		inputTokens: 1,
		outputTokens: 1,
	});

	function groupingRun(options: { waitMs: number; spentThemes: string[] }) {
		const drafted: string[] = [];
		const persisted: unknown[] = [];
		const failed: unknown[] = [];
		const result = run({
			bundle: grouping,
			workflowType: "securityFindingGroupingWorkflow",
			input: {
				groupingId: "grouping-1",
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
			},
			// What `scan.grouping.start` sets.
			executionTimeoutMs: 30 * MINUTE,
			waitMs: options.waitMs,
			activities: {
				markGroupingRunningActivity: async () => undefined,
				gatherEligibleFindingsActivity: async () => ({
					themes: [theme("a"), theme("b"), theme("c")],
					overflowThemes: [],
					scanCompletedAt: null,
					findingCount: 3,
				}),
				proposeThemeActivity: async (input: never) => {
					const { themeKey } = (
						input as { theme: { themeKey: string } }
					).theme;
					drafted.push(themeKey);
					const first =
						drafted.filter((key) => key === themeKey).length === 1;
					if (first && options.spentThemes.includes(themeKey)) {
						throw spent();
					}
					return proposal(themeKey);
				},
				persistGroupingProposalsActivity: async (input: never) => {
					persisted.push(input);
					const { proposedCreate, failedThemes } = input as {
						proposedCreate: unknown[];
						failedThemes: unknown[];
					};
					return {
						proposedCreateCount: proposedCreate.length,
						proposedUpdateCount: 0,
						declinedCount: 0,
						skippedCount: 0,
						failedCount: failedThemes.length,
					};
				},
				failGroupingActivity: async (input: never) => {
					failed.push(input);
				},
			},
		});
		return result.then((outcome) => ({
			...outcome,
			drafted,
			persisted,
			failed,
		}));
	}

	it("waits for the reset and drafts only the spent theme again", async () => {
		const { output, drafted, estimates, timers, elapsedMs } =
			await groupingRun({ waitMs: 10 * MINUTE, spentThemes: ["b"] });

		expect(output).toMatchObject({ success: true, proposedCreateCount: 3 });
		expect([...drafted].sort()).toEqual(["a", "b", "b", "c"]);
		// The clicker's own plan never serves bulk work, so it is not asked.
		expect(estimates).toEqual([{ organizationId: "org-1", userId: null }]);
		expect(timers).toBe(1);
		expect(elapsedMs).toBeGreaterThanOrEqual(10 * MINUTE);
	}, 120_000);

	it("pauses, keeping the drafted themes, when the reset is past the run's deadline", async () => {
		const { output, drafted, timers, pauses, persisted, failed } =
			await groupingRun({
				waitMs: 2 * HOUR,
				spentThemes: ["b"],
			});

		expect(output).toMatchObject({ success: false, paused: true });
		expect([...drafted].sort()).toEqual(["a", "b", "c"]);
		expect(timers).toBe(0);
		expect(persisted).toEqual([]);
		expect(failed).toEqual([]);
		expect(pauses).toHaveLength(1);
		expect(pauses[0]).toMatchObject({
			kind: "SCAN_GROUPING",
			runId: "grouping-1",
			pauseCount: 0,
			waitMs: 2 * HOUR,
			progress: {
				doneThemeKeys: ["a", "c"],
				proposedCreate: [{ themeKey: "a" }, { themeKey: "c" }],
			},
		});
	}, 120_000);

	it("retries at once, with no timer, under an AUTO policy", async () => {
		const { output, drafted, timers } = await groupingRun({
			waitMs: 0,
			spentThemes: ["a", "c"],
		});

		expect(output).toMatchObject({ success: true, proposedCreateCount: 3 });
		expect(drafted).toHaveLength(5);
		expect(timers).toBe(0);
	}, 120_000);
});

// =============================================================================
// False-positive review: the retry after the wait judges only the findings
// the first attempt had not reached.
// =============================================================================

describe("scanFindingReviewWorkflow", () => {
	it("waits for the reset and resumes from the findings already judged", async () => {
		const progress = {
			judgedFindingIds: ["f1", "f2"],
			proposals: [{ findingId: "f1", verdict: "false_positive" }],
			inputTokens: 10,
			outputTokens: 5,
		};
		const reviewInputs: Array<{ resume?: unknown }> = [];
		const persisted: Array<Record<string, unknown>> = [];
		const { output, estimates, timers } = await run({
			bundle: review,
			workflowType: "scanFindingReviewWorkflow",
			input: {
				reviewId: "review-1",
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
			},
			// What `scan.review.start` sets.
			executionTimeoutMs: 30 * MINUTE,
			waitMs: 5 * MINUTE,
			activities: {
				markReviewRunningActivity: async () => undefined,
				gatherReviewFindingsActivity: async () => ({
					findings: ["f1", "f2", "f3", "f4"].map((id) => ({ id })),
					rubric: "rubric",
				}),
				runFindingReviewActivity: async (input: never) => {
					reviewInputs.push(input as { resume?: unknown });
					if (reviewInputs.length === 1) {
						throw spent(progress);
					}
					return {
						proposals: [
							...progress.proposals,
							{ findingId: "f4", verdict: "uncertain" },
						],
						reviewedCount: 4,
						modelName: "model",
						inputTokens: 20,
						outputTokens: 10,
					};
				},
				persistReviewResultsActivity: async (input: never) => {
					persisted.push(input as Record<string, unknown>);
					return { reviewedCount: 4, flaggedCount: 1 };
				},
				failReviewActivity: async () => undefined,
			},
		});

		expect(output).toMatchObject({ success: true, reviewedCount: 4 });
		expect(reviewInputs).toHaveLength(2);
		expect(reviewInputs[0]?.resume).toBeUndefined();
		expect(reviewInputs[1]?.resume).toEqual(progress);
		expect(persisted[0]).toMatchObject({ reviewedCount: 4 });
		expect(estimates).toEqual([{ organizationId: "org-1", userId: null }]);
		expect(timers).toBe(1);
	}, 120_000);
});

// =============================================================================
// Scans: a scanner that ran out part-way resumes with the items it scanned.
// =============================================================================

describe("securityAccessibilityScanWorkflow", () => {
	it("waits for the reset and resumes the scanner from the items it scanned", async () => {
		const progress = {
			doneItemKeys: ["item-1"],
			findings: [{ title: "Finding from item 1" }],
			inputTokens: 10,
			outputTokens: 5,
		};
		const scannerInputs: Array<{ resume?: unknown }> = [];
		const persisted: Array<Record<string, unknown>> = [];
		const { output, timers } = await run({
			bundle: scan,
			workflowType: "securityAccessibilityScanWorkflow",
			input: {
				scanId: "scan-1",
				projectId: "project-1",
				targetType: "PROJECT",
				userId: "user-1",
				organizationId: "org-1",
				securityRequested: true,
				accessibilityRequested: false,
			},
			// What `startProjectScan` sets.
			executionTimeoutMs: 90 * MINUTE,
			waitMs: 5 * MINUTE,
			activities: {
				markScanRunningActivity: async () => undefined,
				gatherScanContextActivity: async () => ({
					projectName: "Example project",
					contentQuery: {
						projectId: "project-1",
						targetType: "PROJECT",
						sinceCompletedAt: null,
					},
					scannedItemKeys: ["item-1", "item-2"],
					securityRules: [],
					accessibilityRules: [],
					severityRubric: [],
					knowledgePacks: [],
					semgrepEnabled: false,
					gitHistoryEnabled: false,
					autoReviewEnabled: false,
				}),
				resolveScanCommitActivity: async () => ({
					codeScanMode: "FULL",
				}),
				runSecurityScanActivity: async (input: never) => {
					scannerInputs.push(input as { resume?: unknown });
					if (scannerInputs.length === 1) {
						throw spent(progress);
					}
					return {
						findings: [
							...progress.findings,
							{ title: "Finding from item 2" },
						],
						modelName: "model",
						inputTokens: 20,
						outputTokens: 10,
					};
				},
				persistScanResultsActivity: async (input: never) => {
					persisted.push(input as Record<string, unknown>);
					return {
						securityFindingCount: 2,
						accessibilityFindingCount: 0,
					};
				},
				failScanActivity: async () => undefined,
			},
		});

		expect(output).toMatchObject({
			success: true,
			securityFindingCount: 2,
		});
		expect(scannerInputs).toHaveLength(2);
		expect(scannerInputs[1]?.resume).toEqual(progress);
		expect(persisted[0]).toMatchObject({
			failedScanners: [],
			security: { findings: [{}, {}] },
		});
		expect(timers).toBe(1);
	}, 120_000);

	it("pauses the scan, keeping the scanner's progress, when the reset is past its deadline", async () => {
		const failures: Array<{ message: string }> = [];
		const { output, timers, pauses } = await run({
			bundle: scan,
			workflowType: "securityAccessibilityScanWorkflow",
			input: {
				scanId: "scan-1",
				projectId: "project-1",
				targetType: "PROJECT",
				userId: "user-1",
				organizationId: "org-1",
				securityRequested: true,
				accessibilityRequested: false,
			},
			executionTimeoutMs: 90 * MINUTE,
			// 90m - (60m scanner + 2m) leaves 28 minutes; the reset is an hour off.
			waitMs: HOUR,
			activities: {
				markScanRunningActivity: async () => undefined,
				gatherScanContextActivity: async () => ({
					projectName: "Example project",
					contentQuery: {
						projectId: "project-1",
						targetType: "PROJECT",
						sinceCompletedAt: null,
					},
					scannedItemKeys: [],
					securityRules: [],
					accessibilityRules: [],
					severityRubric: [],
					knowledgePacks: [],
					semgrepEnabled: false,
					gitHistoryEnabled: false,
					autoReviewEnabled: false,
				}),
				resolveScanCommitActivity: async () => ({
					codeScanMode: "FULL",
				}),
				runSecurityScanActivity: async () => {
					throw spent({
						doneItemKeys: ["item-1"],
						findings: [],
						inputTokens: 1,
						outputTokens: 1,
					});
				},
				persistScanResultsActivity: async () => ({
					securityFindingCount: 0,
					accessibilityFindingCount: 0,
				}),
				failScanActivity: async (input: never) => {
					failures.push(input as { message: string });
				},
			},
		});

		expect(output).toMatchObject({
			success: false,
			paused: true,
			resumesAt: "2026-10-12T15:00:00.000Z",
		});
		expect(timers).toBe(0);
		expect(failures).toEqual([]);
		expect(pauses).toHaveLength(1);
		expect(pauses[0]).toMatchObject({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			workflowType: "securityAccessibilityScanWorkflow",
			input: { scanId: "scan-1", securityRequested: true },
			progress: { security: { progress: { doneItemKeys: ["item-1"] } } },
		});
	}, 120_000);
});
