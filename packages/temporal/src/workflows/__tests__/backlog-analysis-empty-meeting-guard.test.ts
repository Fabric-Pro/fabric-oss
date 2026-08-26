/**
 * The workflow must not propose backlog changes from a meeting it never got
 * (Fizzy #2260).
 *
 * When Teams transcript ingest broke, prod runs reached the analyzer with an
 * empty transcript, no RAG hits and nothing but the backlog — and the model
 * proposed work anyway. One run on 20 Aug created three items off application
 * logs and the existing backlog that nobody had discussed. To the person who
 * asked for an update on that day's meeting, it read as invention.
 *
 * These assert the guard fires when it should and, just as importantly, that it
 * does NOT fire when the run gathered something real besides the meetings.
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

interface RunOptions {
	/** Meetings the user selected for this update. */
	selectedMeetings?: Array<{ joinUrl: string; startTime?: string }>;
	/** A transcript for every selected meeting, or none at all. */
	transcriptAvailable?: boolean;
	/** Simulates a second source that DID return something. */
	logClause?: string;
}

async function runWorkflow(options: RunOptions): Promise<{
	analyzerCalled: boolean;
	result: { success: boolean; skippedReason?: string };
}> {
	let analyzerCalled = false;

	const activities = {
		fetchTeamsMessagesForBacklog: async () => ({
			success: true,
			messages: "",
		}),
		fetchSlackMessagesForBacklog: async () => ({
			success: true,
			messages: "",
		}),
		fetchMeetingTranscript: async () =>
			options.transcriptAvailable
				? {
						success: true,
						transcript:
							"## Meeting Transcript: Standup\nAlex: ship it.",
					}
				: {
						success: false,
						transcript: "",
						error: "No transcripts available for this meeting.",
					},
		fetchNotionPageContent: async () => ({ success: false, content: "" }),
		retrieveProjectRagContext: async () => ({
			success: true,
			formattedContext: "",
			chunkCount: 0,
		}),
		fetchDecisionsForBacklog: async () => ({
			success: false,
			formattedDecisions: "",
		}),
		fetchApplicationLogsForBacklog: async () => ({
			clause: options.logClause ?? "",
			note: "",
			status: options.logClause ? "included" : "not-configured",
			entryCount: options.logClause ? 1 : 0,
		}),
		fetchBacklogSnapshot: async () => ({
			epics: [],
			orphanFeatures: [],
			orphanStories: [],
		}),
		fetchPMWorkItemsByType: async () => ({ success: false, items: [] }),
		analyzeContextAndPropose: async () => {
			analyzerCalled = true;
			return { summary: "", contextSummary: "", changes: [] };
		},
		runBacklogDecisionPrecheckActivity: async () => ({ findings: [] }),
		postOperationResultActivity: async () => undefined,
	};

	const input: BacklogContextAnalysisInput = {
		projectId: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
		contextSources: {
			fetchTeamsMessages: false,
			...(options.selectedMeetings
				? { selectedMeetings: options.selectedMeetings }
				: {}),
		},
		userPrompt: "Update the backlog from today's standup",
	};

	const taskQueue = `backlog-empty-meeting-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});

	const result = (await worker.runUntil(
		env.client.workflow.execute(WORKFLOW_NAME, {
			args: [input],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
		}),
	)) as { success: boolean; skippedReason?: string };

	return { analyzerCalled, result };
}

describe("backlogContextAnalysisWorkflow — no meeting content", () => {
	it("proposes nothing, and says why, when no selected meeting has a transcript", async () => {
		const { analyzerCalled, result } = await runWorkflow({
			selectedMeetings: [
				{ joinUrl: "https://teams.example.com/meet/1" },
				{ joinUrl: "https://teams.example.com/meet/2" },
			],
			transcriptAvailable: false,
		});

		// THE assertion. Reaching the analyzer at all is the defect: it is what
		// turned an ingest outage into three invented work items in prod.
		expect(analyzerCalled).toBe(false);
		expect(result.success).toBe(true);
		expect(result.skippedReason).toMatch(/no.*transcript|transcript.*yet/i);
	});

	it("still analyses when the meetings failed but something else was gathered", async () => {
		const { analyzerCalled, result } = await runWorkflow({
			selectedMeetings: [{ joinUrl: "https://teams.example.com/meet/1" }],
			transcriptAvailable: false,
			logClause: "- 2026-08-19T10:00:00Z [ERROR] checkout timed out",
		});

		expect(analyzerCalled).toBe(true);
		expect(result.skippedReason).toBeUndefined();
	});

	it("is inert on a run that never asked for a meeting", async () => {
		const { analyzerCalled, result } = await runWorkflow({});

		expect(analyzerCalled).toBe(true);
		expect(result.skippedReason).toBeUndefined();
	});

	it("analyses normally when the transcript is there", async () => {
		const { analyzerCalled, result } = await runWorkflow({
			selectedMeetings: [{ joinUrl: "https://teams.example.com/meet/1" }],
			transcriptAvailable: true,
		});

		expect(analyzerCalled).toBe(true);
		expect(result.skippedReason).toBeUndefined();
	});
});
