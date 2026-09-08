/**
 * Unit test for the stale-generation watchdog workflow body.
 *
 * The sweep writes a terminal FAILED a user sees, so the contract worth pinning
 * is what it refuses to do: a row whose workflow Temporal still reports as
 * running is skipped, not failed. Every uncertainty in that check already
 * resolves to "live" inside the activity, so this asserts the workflow honours
 * that answer rather than overriding it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	findStaleGeneratingDocumentsActivity: vi.fn(),
	isGenerationWorkflowLiveActivity: vi.fn(),
	markGenerationTimedOutActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	proxyActivities: vi.fn(() => activityStubs),
}));

import { documentGenerationWatchdogWorkflow } from "../src/workflows/document-generation-watchdog";

const row = (over: Record<string, unknown> = {}) => ({
	documentId: "doc-1",
	projectId: "proj-1",
	organizationId: "org-1",
	status: "GENERATING" as const,
	workflowId: "wf-1",
	generationStartedAtMs: 1_000,
	...over,
});

/** An hour-old queued row — the age a healthy dependency wait can reach. */
const queuedRow = (over: Record<string, unknown> = {}) =>
	row({
		status: "QUEUED",
		generationStartedAtMs: Date.now() - 60 * 60_000,
		...over,
	});

beforeEach(() => {
	activityStubs.findStaleGeneratingDocumentsActivity.mockReset();
	activityStubs.isGenerationWorkflowLiveActivity.mockReset();
	activityStubs.markGenerationTimedOutActivity.mockReset();
	activityStubs.markGenerationTimedOutActivity.mockResolvedValue(undefined);
});

describe("documentGenerationWatchdogWorkflow", () => {
	it("fails a row whose workflow is confirmed not running", async () => {
		activityStubs.findStaleGeneratingDocumentsActivity.mockResolvedValue({
			rows: [row()],
		});
		activityStubs.isGenerationWorkflowLiveActivity.mockResolvedValue(false);

		const out = await documentGenerationWatchdogWorkflow();

		expect(out).toEqual({ failed: 1, skippedLive: 0, scanned: 1 });
		expect(
			activityStubs.markGenerationTimedOutActivity,
		).toHaveBeenCalledWith({
			documentId: "doc-1",
			generationStartedAtMs: 1_000,
		});
	});

	/**
	 * The guard. A slow-but-alive run is past the ceiling too, and failing it
	 * would discard work the user is still waiting for.
	 */
	it("skips a row whose workflow is still running", async () => {
		activityStubs.findStaleGeneratingDocumentsActivity.mockResolvedValue({
			rows: [row()],
		});
		activityStubs.isGenerationWorkflowLiveActivity.mockResolvedValue(true);

		const out = await documentGenerationWatchdogWorkflow();

		expect(out).toEqual({ failed: 0, skippedLive: 1, scanned: 1 });
		expect(
			activityStubs.markGenerationTimedOutActivity,
		).not.toHaveBeenCalled();
	});

	/**
	 * A row that never recorded a workflow id never got far enough for one to
	 * exist, so there is nothing to ask about — but it must still be swept, or
	 * the earliest-failing dispatches would be the ones that leak forever.
	 */
	it("fails a row with no workflow id without asking Temporal", async () => {
		activityStubs.findStaleGeneratingDocumentsActivity.mockResolvedValue({
			rows: [row({ workflowId: null })],
		});

		const out = await documentGenerationWatchdogWorkflow();

		expect(out.failed).toBe(1);
		expect(
			activityStubs.isGenerationWorkflowLiveActivity,
		).not.toHaveBeenCalled();
	});

	/**
	 * The queued arm. A row waiting on its dependencies has no age at which it
	 * becomes suspicious — the query hands it over at any age precisely so this
	 * check, and only this check, decides. A workflow that is gone means the
	 * wait is never going to end on its own.
	 */
	it("fails a queued row whose workflow is gone, however recent it is", async () => {
		activityStubs.findStaleGeneratingDocumentsActivity.mockResolvedValue({
			rows: [queuedRow({ generationStartedAtMs: Date.now() })],
		});
		activityStubs.isGenerationWorkflowLiveActivity.mockResolvedValue(false);

		const out = await documentGenerationWatchdogWorkflow();

		expect(out).toEqual({ failed: 1, skippedLive: 0, scanned: 1 });
	});

	/**
	 * The whole reason QUEUED is a separate status. An hour-long wait is the
	 * queue working as designed; sweeping it would kill a run the user is still
	 * waiting for and hand them a failure they cannot explain.
	 */
	it("leaves an hour-old queued row alone while its workflow is live", async () => {
		activityStubs.findStaleGeneratingDocumentsActivity.mockResolvedValue({
			rows: [queuedRow()],
		});
		activityStubs.isGenerationWorkflowLiveActivity.mockResolvedValue(true);

		const out = await documentGenerationWatchdogWorkflow();

		expect(out).toEqual({ failed: 0, skippedLive: 1, scanned: 1 });
		expect(
			activityStubs.markGenerationTimedOutActivity,
		).not.toHaveBeenCalled();
	});

	it("keeps sweeping after one row throws", async () => {
		activityStubs.findStaleGeneratingDocumentsActivity.mockResolvedValue({
			rows: [
				row({ documentId: "doc-bad" }),
				row({ documentId: "doc-2" }),
			],
		});
		activityStubs.isGenerationWorkflowLiveActivity.mockResolvedValue(false);
		activityStubs.markGenerationTimedOutActivity
			.mockRejectedValueOnce(new Error("db down"))
			.mockResolvedValueOnce(undefined);

		const out = await documentGenerationWatchdogWorkflow();

		expect(out).toEqual({ failed: 1, skippedLive: 0, scanned: 2 });
	});

	/**
	 * The env-or-default fallback lives in the activity, because `process.env`
	 * is non-deterministic in a workflow. Passing 0 is how that decision is
	 * handed over — a literal ceiling read here would sweep every in-flight run.
	 */
	it("hands the ceiling decision to the activity", async () => {
		activityStubs.findStaleGeneratingDocumentsActivity.mockResolvedValue({
			rows: [],
		});

		await documentGenerationWatchdogWorkflow();

		expect(
			activityStubs.findStaleGeneratingDocumentsActivity,
		).toHaveBeenCalledWith({ staleAfterMinutes: 0, batchSize: 50 });
	});

	it("passes an explicit ceiling through when given one", async () => {
		activityStubs.findStaleGeneratingDocumentsActivity.mockResolvedValue({
			rows: [],
		});

		await documentGenerationWatchdogWorkflow({
			staleAfterMinutes: 45,
			batchSize: 10,
		});

		expect(
			activityStubs.findStaleGeneratingDocumentsActivity,
		).toHaveBeenCalledWith({ staleAfterMinutes: 45, batchSize: 10 });
	});
});
