/**
 * Bulk runs pause for a ChatGPT plan reset and resume later (Fizzy #2770), in
 * the real workflows: a resume run claims its row and continues from the saved
 * progress, a resume that lost the claim ends without doing anything, a
 * second refusal pauses again under the run's first workflow id, the pause
 * cap fails the run with its message, and a document batch queues the
 * documents it had not reached for its resume.
 *
 * The workflows run in a time-skipping environment with stubbed activities;
 * the row writes and the delayed start are pinned in the activity's own test.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

// The batch with a stand-in document child: the second document's child
// ends with the pause, as the real child does when its wait is too long.
const BATCH_PROBE = `
export { batchDocumentGenerationWorkflow } from "../../batch-document-generation";
import { ChatGptPlanPause } from "../../lib/chatgpt-plan-wait";

export async function documentGenerationChildWorkflow(input: {
	documentId: string;
	pauseOnPlanSpent?: boolean;
	aiToken: string;
}) {
	// A resumed batch (fresh token) finds the plans reset.
	if (
		input.documentId === "doc-2" &&
		input.pauseOnPlanSpent &&
		input.aiToken !== "fresh-token"
	) {
		throw new ChatGptPlanPause(3 * 60 * 60_000, true);
	}
	return { documentContent: "", metrics: { token: input.aiToken } };
}
`;

let env: TestWorkflowEnvironment;
let scan: WorkflowBundleWithSourceMap;
let batch: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	scan = await bundleWorkflowCode({
		workflowsPath: resolve(WORKFLOWS, "security-accessibility-scan.ts"),
	});
	const dir = mkdtempSync(join(__dirname, ".bulk-run-pause-"));
	try {
		writeFileSync(join(dir, "probe.ts"), BATCH_PROBE);
		batch = await bundleWorkflowCode({
			workflowsPath: join(dir, "probe.ts"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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

type PauseResult =
	| { paused: true; resumesAt: string; pauseCount: number }
	| { paused: false; message: string };

async function run(options: {
	bundle: WorkflowBundleWithSourceMap;
	workflowType: string;
	input: unknown;
	activities: Record<string, (...args: never[]) => Promise<unknown>>;
	claim?: { claimed: boolean; progress?: unknown };
	pauseResult?: PauseResult;
	waitMs?: number;
	/** A second queue the workflow schedules activities on. */
	activityQueue?: string;
}) {
	const taskQueue = `bulk-run-pause-${++taskQueueSeq}`;
	const pauses: Array<Record<string, unknown>> = [];
	const claims: Array<Record<string, unknown>> = [];
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: options.bundle,
		activities: {
			...options.activities,
			estimatePlanPoolResetActivity: async () => ({
				waitMs: options.waitMs ?? 3 * HOUR,
				jitterMs: 0,
				resetKnown: true,
			}),
			pauseBulkRunActivity: async (input: Record<string, unknown>) => {
				pauses.push(input);
				return (
					options.pauseResult ?? {
						paused: true,
						resumesAt: "2026-10-12T18:00:00.000Z",
						pauseCount: ((input.pauseCount as number) ?? 0) + 1,
					}
				);
			},
			claimBulkRunResumeActivity: async (
				input: Record<string, unknown>,
			) => {
				claims.push(input);
				return options.claim ?? { claimed: true };
			},
		},
	});
	const handle = await env.client.workflow.start(options.workflowType, {
		taskQueue,
		workflowId: `${taskQueue}-wf`,
		args: [options.input],
		workflowExecutionTimeout: 90 * MINUTE,
	});
	// The batch's own activities run on the document-generation queue.
	const activityWorker = options.activityQueue
		? await Worker.create({
				connection: env.nativeConnection,
				taskQueue: options.activityQueue,
				activities: options.activities,
			})
		: null;
	const result = worker.runUntil(handle.result());
	const output = await (activityWorker
		? activityWorker.runUntil(result)
		: result);
	return { output, pauses, claims };
}

// =============================================================================
// Scans
// =============================================================================

const scanInput = {
	scanId: "scan-1",
	projectId: "project-1",
	targetType: "PROJECT",
	userId: "user-1",
	organizationId: "org-1",
	jobType: "security-scan",
	securityRequested: true,
	accessibilityRequested: true,
};

function scanActivities(log: {
	marked: unknown[];
	scanned: Array<{ category: string; resume?: unknown }>;
	persisted: Array<Record<string, unknown>>;
	failed: Array<{ message: string }>;
	spentSecurity?: boolean;
}) {
	const result = (title: string) => ({
		findings: [{ title }],
		modelName: "model",
		inputTokens: 1,
		outputTokens: 1,
	});
	return {
		markScanRunningActivity: async (input: never) => {
			log.marked.push(input);
		},
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
		resolveScanCommitActivity: async () => ({ codeScanMode: "FULL" }),
		runSecurityScanActivity: async (input: never) => {
			const { resume } = input as { resume?: unknown };
			log.scanned.push({ category: "security", resume });
			if (log.spentSecurity) {
				throw spent({
					doneItemKeys: ["item-1"],
					findings: [{ title: "Security 1" }],
					inputTokens: 1,
					outputTokens: 1,
				});
			}
			return result("Security");
		},
		runAccessibilityScanActivity: async (input: never) => {
			const { resume } = input as { resume?: unknown };
			log.scanned.push({ category: "accessibility", resume });
			return result("Accessibility");
		},
		persistScanResultsActivity: async (input: never) => {
			log.persisted.push(input as Record<string, unknown>);
			return { securityFindingCount: 1, accessibilityFindingCount: 1 };
		},
		failScanActivity: async (input: never) => {
			log.failed.push(input as { message: string });
		},
	};
}

function scanLog(spentSecurity = false) {
	return {
		marked: [] as unknown[],
		scanned: [] as Array<{ category: string; resume?: unknown }>,
		persisted: [] as Array<Record<string, unknown>>,
		failed: [] as Array<{ message: string }>,
		spentSecurity,
	};
}

describe("securityAccessibilityScanWorkflow pause and resume", () => {
	it("pauses on a spent plan: saves the finished scanner and the other's progress, never fails", async () => {
		const log = scanLog(true);
		const { output, pauses } = await run({
			bundle: scan,
			workflowType: "securityAccessibilityScanWorkflow",
			input: scanInput,
			activities: scanActivities(log),
		});

		expect(output).toMatchObject({ success: false, paused: true });
		expect(log.failed).toEqual([]);
		expect(log.persisted).toEqual([]);
		expect(pauses).toHaveLength(1);
		expect(pauses[0]).toMatchObject({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			pauseCount: 0,
			workflowIdBase: expect.stringMatching(/-wf$/),
			workflowType: "securityAccessibilityScanWorkflow",
			executionTimeoutMs: 90 * MINUTE,
			waitMs: 3 * HOUR,
			resetKnown: true,
			// The job type rides along, so the resume runs as the same job.
			input: { scanId: "scan-1", jobType: "security-scan" },
			progress: {
				security: { progress: { doneItemKeys: ["item-1"] } },
				accessibility: {
					done: { findings: [{ title: "Accessibility" }] },
				},
			},
		});
		expect(
			(pauses[0]?.input as Record<string, unknown>).resumeOf,
		).toBeUndefined();
	}, 120_000);

	it("resumes from the saved progress: claims the row, skips the finished scanner", async () => {
		const log = scanLog();
		const progress = {
			doneItemKeys: ["item-1"],
			findings: [{ title: "Security 1" }],
			inputTokens: 1,
			outputTokens: 1,
		};
		const { output, claims, pauses } = await run({
			bundle: scan,
			workflowType: "securityAccessibilityScanWorkflow",
			input: {
				...scanInput,
				resumeOf: {
					runId: "scan-1",
					pauseCount: 1,
					workflowIdBase: "security-scan-scan-1",
				},
			},
			claim: {
				claimed: true,
				progress: {
					security: { progress },
					accessibility: {
						done: {
							findings: [{ title: "Accessibility" }],
							modelName: "model",
							inputTokens: 1,
							outputTokens: 1,
						},
					},
				},
			},
			activities: scanActivities(log),
		});

		expect(output).toMatchObject({ success: true });
		expect(claims).toEqual([
			{
				kind: "PROJECT_SCAN",
				resumeOf: {
					runId: "scan-1",
					pauseCount: 1,
					workflowIdBase: "security-scan-scan-1",
				},
				viaApiOverride: false,
			},
		]);
		// The claim set RUNNING; the first run's start write is not repeated.
		expect(log.marked).toEqual([]);
		expect(log.scanned).toEqual([
			{ category: "security", resume: progress },
		]);
		expect(log.persisted[0]).toMatchObject({
			security: { findings: [{ title: "Security" }] },
			accessibility: { findings: [{ title: "Accessibility" }] },
		});
		expect(pauses).toEqual([]);
	}, 120_000);

	it("a resume that lost its claim (cancelled meanwhile) does nothing", async () => {
		const log = scanLog();
		const { output } = await run({
			bundle: scan,
			workflowType: "securityAccessibilityScanWorkflow",
			input: {
				...scanInput,
				resumeOf: {
					runId: "scan-1",
					pauseCount: 1,
					workflowIdBase: "security-scan-scan-1",
				},
			},
			claim: { claimed: false },
			activities: scanActivities(log),
		});

		expect(output).toMatchObject({ success: false });
		expect(log.scanned).toEqual([]);
		expect(log.persisted).toEqual([]);
		expect(log.failed).toEqual([]);
	}, 120_000);

	it("pauses again on resume under the first run's id and the next pause count", async () => {
		const log = scanLog(true);
		const { output, pauses } = await run({
			bundle: scan,
			workflowType: "securityAccessibilityScanWorkflow",
			input: {
				...scanInput,
				resumeOf: {
					runId: "scan-1",
					pauseCount: 2,
					workflowIdBase: "security-scan-scan-1",
				},
			},
			activities: scanActivities(log),
		});

		expect(output).toMatchObject({ paused: true });
		expect(pauses[0]).toMatchObject({
			pauseCount: 2,
			workflowIdBase: "security-scan-scan-1",
		});
		expect(
			(pauses[0]?.input as Record<string, unknown>).resumeOf,
		).toBeUndefined();
	}, 120_000);

	it("fails the scan with the cap's message once the pauses are used up", async () => {
		const log = scanLog(true);
		const { output } = await run({
			bundle: scan,
			workflowType: "securityAccessibilityScanWorkflow",
			input: scanInput,
			pauseResult: {
				paused: false,
				message:
					"Every ChatGPT plan this work may use stayed spent through every pause.",
			},
			activities: scanActivities(log),
		});

		expect(output).toMatchObject({ success: false });
		expect(output).not.toHaveProperty("paused");
		expect(log.failed[0]?.message).toContain(
			"stayed spent through every pause",
		);
	}, 120_000);

	it("waits in place, without pausing, for a reset a few minutes off", async () => {
		const log = scanLog();
		let first = true;
		const activities = {
			...scanActivities(log),
			runSecurityScanActivity: async () => {
				if (first) {
					first = false;
					throw spent();
				}
				return {
					findings: [],
					modelName: "model",
					inputTokens: 1,
					outputTokens: 1,
				};
			},
		};
		const { output, pauses } = await run({
			bundle: scan,
			workflowType: "securityAccessibilityScanWorkflow",
			input: scanInput,
			waitMs: 5 * MINUTE,
			activities,
		});

		expect(output).toMatchObject({ success: true });
		expect(pauses).toEqual([]);
	}, 120_000);
});

// =============================================================================
// Batch document generation
// =============================================================================

describe("batchDocumentGenerationWorkflow pause and resume", () => {
	const documents = [
		{ id: "doc-1", type: "PRD", title: "PRD", prompt: "p" },
		{ id: "doc-2", type: "ARCHITECTURE", title: "Arch", prompt: "p" },
		{ id: "doc-3", type: "USER_STORY", title: "Features", prompt: "p" },
	];

	function batchActivities(log: {
		statuses: Array<{ documentId: string; status: string }>;
		tasks: Array<{ status: string }>;
		tokens: unknown[];
	}) {
		return {
			createAgentTask: async () => ({ id: "task-1" }),
			updateAgentTaskWorkflow: async () => undefined,
			updateAgentTaskStatus: async (input: never) => {
				log.tasks.push(input as { status: string });
			},
			updateProjectDocumentStatus: async (input: never) => {
				log.statuses.push(
					input as { documentId: string; status: string },
				);
				return undefined;
			},
			issueGenerationToken: async (input: never) => {
				log.tokens.push(input);
				return { aiToken: "fresh-token" };
			},
		};
	}

	it("queues the documents it had not reached and pauses, without failing any", async () => {
		const log = { statuses: [], tasks: [], tokens: [] } as {
			statuses: Array<{ documentId: string; status: string }>;
			tasks: Array<{ status: string }>;
			tokens: unknown[];
		};
		const { output, pauses } = await run({
			bundle: batch,
			workflowType: "batchDocumentGenerationWorkflow",
			activityQueue: "project-document-generation",
			input: {
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
				jobType: "batch-document-generation",
				aiToken: "secret-token",
				documents,
			},
			activities: batchActivities(log),
		});

		expect(output).toMatchObject({
			success: false,
			paused: true,
			results: [{ documentId: "doc-1", status: "success" }],
		});
		expect(log.statuses.filter((s) => s.status === "FAILED")).toEqual([]);
		// The AgentTask is left to the pause: no COMPLETED / FAILED write.
		expect(log.tasks.map((t) => t.status)).toEqual(["RUNNING"]);
		expect(pauses[0]).toMatchObject({
			kind: "DOCUMENT_BATCH",
			runId: "task-1",
			queuedDocumentIds: ["doc-2", "doc-3"],
			input: {
				aiToken: "",
				documents: [{ id: "doc-2" }, { id: "doc-3" }],
			},
			progress: { results: [{ documentId: "doc-1", status: "success" }] },
		});
	}, 120_000);

	it("resumes on the same AgentTask with a fresh token and the earlier results", async () => {
		const log = { statuses: [], tasks: [], tokens: [] } as {
			statuses: Array<{ documentId: string; status: string }>;
			tasks: Array<{ status: string; result?: unknown }>;
			tokens: unknown[];
		};
		const { output, claims } = await run({
			bundle: batch,
			workflowType: "batchDocumentGenerationWorkflow",
			activityQueue: "project-document-generation",
			input: {
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
				aiToken: "",
				// The API override: the resume may bill the provider, so the
				// stand-in child is not asked to pause.
				allowApiFallback: true,
				documents: documents.slice(1),
				resumeOf: {
					runId: "task-1",
					pauseCount: 1,
					workflowIdBase: "batch-document-generation-project-1-1",
				},
			},
			claim: {
				claimed: true,
				progress: {
					results: [{ documentId: "doc-1", status: "success" }],
				},
			},
			activities: {
				...batchActivities(log),
				createAgentTask: async () => {
					throw new Error("a resume never creates a second task");
				},
			},
		});

		expect(claims[0]).toMatchObject({ viaApiOverride: true });
		expect(log.tokens).toHaveLength(1);
		expect(output).toMatchObject({ results: expect.any(Array) });
		const final = log.tasks.at(-1) as {
			status: string;
			result?: { documentCount: number };
		};
		expect(final.result?.documentCount).toBe(3);
	}, 120_000);
});
