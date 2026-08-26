/**
 * Behavioural (TestWorkflowEnvironment) tests for the application-log context
 * step of `backlogContextAnalysisWorkflow` (Fizzy #1234).
 *
 * These run the REAL workflow code on a real (time-skipping) Temporal server
 * with mocked activities, which is the only thing that can prove the seam the
 * feature actually broke on: the log clause has to travel from step 1f into the
 * `fetchedContext` that reaches `analyzeContextAndPropose`. Every unit test in
 * this feature asserted on one side of that handoff or the other, and the
 * handoff itself was silently dropping the value.
 *
 * The complementary half — `fetchedContext.applicationLogs` reaching the actual
 * prompt string — is covered by `__tests__/analyze-context-prompt.test.ts`,
 * which invokes the real `analyzeContextAndPropose`. Together they cover
 * workflow → activity → prompt under real execution.
 *
 * Offline note: `createTimeSkipping()` downloads a Temporal test-server binary
 * on first use; run once online to populate the cache.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test backlog-analysis-log-context
 */

import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BacklogContextAnalysisInput } from "../backlog-context-analysis-workflow";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const WORKFLOW_NAME = "backlogContextAnalysisWorkflow";

const LOG_CLAUSE = [
	"Source: Ops Logs. These entries were retrieved for this analysis",
	"",
	"- 2026-08-19T10:00:00Z [ERROR] ZZQX-CANARY reservation timed out",
].join("\n");

const BASE_INPUT: BacklogContextAnalysisInput = {
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-1",
	// Everything off so the run is short: RAG, decisions and logs still run.
	contextSources: { fetchTeamsMessages: false },
	userPrompt: "Analyze the checkout failures",
};

interface LogActivityResult {
	clause: string;
	note: string;
	status: string;
	entryCount: number;
}

interface Captured {
	/** The `fetchedContext` the analyzer actually received. */
	analyzerContext?: Record<string, unknown>;
}

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

async function runWorkflow(logResult: LogActivityResult): Promise<{
	captured: Captured;
	result: { success: boolean; logContextNote?: string };
}> {
	const captured: Captured = {};

	const activities = {
		fetchTeamsMessagesForBacklog: async () => ({
			success: true,
			messages: "",
		}),
		fetchSlackMessagesForBacklog: async () => ({
			success: true,
			messages: "",
		}),
		fetchMeetingTranscript: async () => ({
			success: false,
			transcript: "",
		}),
		fetchNotionPageContent: async () => ({ success: false, content: "" }),
		retrieveProjectRagContext: async () => ({
			success: false,
			formattedContext: "",
		}),
		fetchDecisionsForBacklog: async () => ({
			success: false,
			formattedDecisions: "",
		}),
		// The activity under test. Returning a clause simulates the flag being
		// on with a configured, reachable log source.
		fetchApplicationLogsForBacklog: async () => logResult,
		fetchBacklogSnapshot: async () => ({
			epics: [],
			orphanFeatures: [],
			orphanStories: [],
		}),
		fetchPMWorkItemsByType: async () => ({ success: false, items: [] }),
		// The capture point: whatever the workflow hands the analyzer.
		analyzeContextAndPropose: async (input: {
			fetchedContext: Record<string, unknown>;
		}) => {
			captured.analyzerContext = input.fetchedContext;
			return { summary: "", contextSummary: "", changes: [] };
		},
		runBacklogDecisionPrecheckActivity: async () => ({ findings: [] }),
		postOperationResultActivity: async () => undefined,
	};

	const taskQueue = `backlog-log-context-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});

	const result = (await worker.runUntil(
		env.client.workflow.execute(WORKFLOW_NAME, {
			args: [BASE_INPUT],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
		}),
	)) as { success: boolean; logContextNote?: string };

	return { captured, result };
}

describe("backlogContextAnalysisWorkflow — application-log context", () => {
	it("hands the fetched log clause to the analyzer", async () => {
		const { captured, result } = await runWorkflow({
			clause: LOG_CLAUSE,
			note: "Included 1 redacted log entry from Ops Logs.",
			status: "included",
			entryCount: 1,
		});

		expect(result.success).toBe(true);
		// THE assertion this whole test file exists for. The clause has to
		// survive the workflow -> activity handoff; it previously did not.
		expect(captured.analyzerContext?.applicationLogs).toBe(LOG_CLAUSE);
		expect(
			String(captured.analyzerContext?.applicationLogs ?? ""),
		).toContain("ZZQX-CANARY");
	});

	it("surfaces the note on the terminal result so a late poller still sees it", async () => {
		const note = "Included 1 redacted log entry from Ops Logs.";
		const { result } = await runWorkflow({
			clause: LOG_CLAUSE,
			note,
			status: "included",
			entryCount: 1,
		});

		expect(result.logContextNote).toBe(note);
	});

	it("completes without logs, and says why, when none are configured", async () => {
		const note =
			"Logs were not available: no log source is configured for this project.";
		const { captured, result } = await runWorkflow({
			clause: "",
			note,
			status: "not-configured",
			entryCount: 0,
		});

		// FR3: the analysis still succeeds, carries no log section, and the
		// user is told why.
		expect(result.success).toBe(true);
		expect(captured.analyzerContext?.applicationLogs).toBeUndefined();
		expect(result.logContextNote).toBe(note);
	});

	it("says nothing at all when the feature is disabled", async () => {
		const { captured, result } = await runWorkflow({
			clause: "",
			note: "Log-backed analysis is not enabled.",
			status: "disabled",
			entryCount: 0,
		});

		expect(result.success).toBe(true);
		expect(captured.analyzerContext?.applicationLogs).toBeUndefined();
		// Someone who never asked for the feature is not told it did not happen.
		expect(result.logContextNote).toBeUndefined();
	});

	it("still completes the analysis when the log activity fails outright", async () => {
		const captured: Captured = {};
		const taskQueue = `backlog-log-context-${taskQueueSeq++}`;
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities: {
				fetchTeamsMessagesForBacklog: async () => ({
					success: true,
					messages: "",
				}),
				fetchSlackMessagesForBacklog: async () => ({
					success: true,
					messages: "",
				}),
				fetchMeetingTranscript: async () => ({
					success: false,
					transcript: "",
				}),
				fetchNotionPageContent: async () => ({
					success: false,
					content: "",
				}),
				retrieveProjectRagContext: async () => ({
					success: false,
					formattedContext: "",
				}),
				fetchDecisionsForBacklog: async () => ({
					success: false,
					formattedDecisions: "",
				}),
				// Throws on every attempt — the workflow must swallow it.
				fetchApplicationLogsForBacklog: async () => {
					throw new Error("log platform exploded");
				},
				fetchBacklogSnapshot: async () => ({
					epics: [],
					orphanFeatures: [],
					orphanStories: [],
				}),
				fetchPMWorkItemsByType: async () => ({
					success: false,
					items: [],
				}),
				analyzeContextAndPropose: async (input: {
					fetchedContext: Record<string, unknown>;
				}) => {
					captured.analyzerContext = input.fetchedContext;
					return { summary: "", contextSummary: "", changes: [] };
				},
				runBacklogDecisionPrecheckActivity: async () => ({
					findings: [],
				}),
				postOperationResultActivity: async () => undefined,
			},
		});

		const result = (await worker.runUntil(
			env.client.workflow.execute(WORKFLOW_NAME, {
				args: [BASE_INPUT],
				taskQueue,
				workflowId: `${taskQueue}-wf`,
			}),
		)) as { success: boolean };

		// The card's graceful-degradation requirement: an optional context
		// source must never take the analysis down with it.
		expect(result.success).toBe(true);
		expect(captured.analyzerContext).toBeDefined();
		expect(captured.analyzerContext?.applicationLogs).toBeUndefined();
	}, 120_000);
});
