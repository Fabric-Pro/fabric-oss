/**
 * Behavioral (TestWorkflowEnvironment) tests for the meeting-only scoping in
 * `backlogContextAnalysisWorkflow`. Bundles the REAL workflow and injects
 * mocked activities. `fetchBacklogSnapshot` fails non-retryably, which ends the
 * run right after the context-fetch steps, so the assertions cover the context
 * activities scheduled before it.
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use.
 */

import { resolve } from "node:path";
import { WorkflowFailedError } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BacklogContextAnalysisInput } from "../src/workflows/backlog-context-analysis-workflow";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "backlogContextAnalysisWorkflow";

const MEETINGS = [{ joinUrl: "https://example.com/meeting" }];

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

function createMocks() {
	return {
		fetchTeamsMessagesForBacklog: vi.fn().mockResolvedValue({
			success: true,
			formattedMessages: "teams",
			messageCount: 1,
		}),
		fetchSlackMessagesForBacklog: vi.fn().mockResolvedValue({
			success: true,
			formattedMessages: "slack",
			messageCount: 1,
		}),
		fetchMeetingTranscript: vi.fn().mockResolvedValue({
			success: true,
			transcript: "Speaker: we agreed to add CSV export.",
		}),
		fetchNotionPageContent: vi.fn(),
		retrieveProjectRagContext: vi.fn().mockResolvedValue({
			success: true,
			formattedContext: "rag",
		}),
		fetchDecisionsForBacklog: vi.fn().mockResolvedValue({
			success: true,
			formattedDecisions: "decisions",
		}),
		fetchSecurityFindingsForBacklog: vi.fn().mockResolvedValue({
			success: true,
			formattedFindings: "findings",
		}),
		fetchApplicationLogsForBacklog: vi.fn().mockResolvedValue({
			clause: "",
			note: "",
			status: "disabled",
		}),
		fetchBacklogSnapshot: vi.fn().mockImplementation(() => {
			throw ApplicationFailure.nonRetryable(
				"stop after context fetch",
				"TEST_STOP",
			);
		}),
	};
}

let taskQueueSeq = 0;

async function runUntilBacklogFetch(
	contextSources: BacklogContextAnalysisInput["contextSources"],
) {
	const mocks = createMocks();
	const taskQueue = `backlog-meeting-only-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: mocks,
	});
	const input: BacklogContextAnalysisInput = {
		projectId: "example-project",
		userId: "example-user",
		organizationId: "example-org",
		contextSources,
		userPrompt: "Analyze context and suggest backlog updates",
	};
	await expect(
		worker.runUntil(
			env.client.workflow.execute(WORKFLOW_NAME, {
				args: [input],
				taskQueue,
				workflowId: `${taskQueue}-wf`,
			}),
		),
	).rejects.toBeInstanceOf(WorkflowFailedError);
	expect(mocks.fetchBacklogSnapshot).toHaveBeenCalledTimes(1);
	return mocks;
}

describe("backlogContextAnalysisWorkflow meeting-only scoping", () => {
	it("fetches only the meetings and architecture decisions for a meeting-only run", async () => {
		const mocks = await runUntilBacklogFetch({
			fetchTeamsMessages: false,
			fetchSlackMessages: false,
			selectedMeetings: MEETINGS,
		});

		expect(mocks.fetchMeetingTranscript).toHaveBeenCalledTimes(1);
		expect(mocks.fetchDecisionsForBacklog).toHaveBeenCalledTimes(1);
		expect(mocks.retrieveProjectRagContext).not.toHaveBeenCalled();
		expect(mocks.fetchSecurityFindingsForBacklog).not.toHaveBeenCalled();
		expect(mocks.fetchApplicationLogsForBacklog).not.toHaveBeenCalled();
		expect(mocks.fetchSlackMessagesForBacklog).not.toHaveBeenCalled();
		expect(mocks.fetchTeamsMessagesForBacklog).not.toHaveBeenCalled();
	}, 60_000);

	it("keeps the background context when meetings are combined with Teams messages", async () => {
		const mocks = await runUntilBacklogFetch({
			fetchTeamsMessages: true,
			selectedMeetings: MEETINGS,
		});

		expect(mocks.fetchTeamsMessagesForBacklog).toHaveBeenCalledTimes(1);
		expect(mocks.fetchMeetingTranscript).toHaveBeenCalledTimes(1);
		expect(mocks.retrieveProjectRagContext).toHaveBeenCalledTimes(1);
		expect(mocks.fetchDecisionsForBacklog).toHaveBeenCalledTimes(1);
		expect(mocks.fetchSecurityFindingsForBacklog).toHaveBeenCalledTimes(1);
		expect(mocks.fetchApplicationLogsForBacklog).toHaveBeenCalledTimes(1);
	}, 60_000);

	it("keeps the background context when meetings are combined with explicit Slack", async () => {
		const mocks = await runUntilBacklogFetch({
			fetchTeamsMessages: false,
			fetchSlackMessages: true,
			selectedMeetings: MEETINGS,
		});

		expect(mocks.fetchSlackMessagesForBacklog).toHaveBeenCalledTimes(1);
		expect(mocks.retrieveProjectRagContext).toHaveBeenCalledTimes(1);
		expect(mocks.fetchSecurityFindingsForBacklog).toHaveBeenCalledTimes(1);
		expect(mocks.fetchApplicationLogsForBacklog).toHaveBeenCalledTimes(1);
	}, 60_000);
});
