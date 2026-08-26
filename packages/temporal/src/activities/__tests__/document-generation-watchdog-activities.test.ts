/**
 * Unit tests for the stale-generation watchdog activities.
 *
 * The sweep writes a terminal FAILED that a user sees, so most of what is
 * asserted here is restraint: which rows it declines to touch, and that every
 * uncertainty in the liveness check resolves toward leaving the row alone. A
 * lingering stale row costs a confusing status; a wrongly-failed row costs work
 * the user was still waiting for, with the model spend already incurred.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findStaleMock: vi.fn(),
	markFailedMock: vi.fn(),
	describeMock: vi.fn(),
	getHandleMock: vi.fn(),
	getTemporalClientMock: vi.fn(),
}));

vi.mock("@repo/database/prisma/queries/projects/documents", () => ({
	findStaleGeneratingDocuments: (...args: unknown[]) =>
		mocks.findStaleMock(...args),
	markDocumentGenerationFailed: (...args: unknown[]) =>
		mocks.markFailedMock(...args),
}));

vi.mock("../../client", () => ({
	getTemporalClient: (...args: unknown[]) =>
		mocks.getTemporalClientMock(...args),
}));

// Import AFTER mocks.
import {
	findStaleGeneratingDocumentsActivity,
	isGenerationWorkflowLiveActivity,
	markGenerationTimedOutActivity,
} from "../document-generation-watchdog-activities";

const STARTED_AT = new Date("2026-08-18T10:00:00.000Z");

beforeEach(() => {
	mocks.findStaleMock.mockReset();
	mocks.markFailedMock.mockReset();
	mocks.describeMock.mockReset();
	mocks.getHandleMock.mockReset();
	mocks.getTemporalClientMock.mockReset();
	mocks.getHandleMock.mockReturnValue({ describe: mocks.describeMock });
	mocks.getTemporalClientMock.mockResolvedValue({
		workflow: { getHandle: mocks.getHandleMock },
	});
	delete process.env.FABRIC_DOCUMENT_GENERATION_STALE_MINUTES;
});

describe("findStaleGeneratingDocumentsActivity", () => {
	it("maps rows and lifts the organization off the project", async () => {
		mocks.findStaleMock.mockResolvedValue([
			{
				id: "doc-1",
				projectId: "proj-1",
				generationStartedAt: STARTED_AT,
				workflowId: "wf-1",
				project: { organizationId: "org-1" },
			},
		]);

		const out = await findStaleGeneratingDocumentsActivity({
			staleAfterMinutes: 30,
			batchSize: 50,
		});

		expect(out.rows).toEqual([
			{
				documentId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
				workflowId: "wf-1",
				generationStartedAtMs: STARTED_AT.getTime(),
			},
		]);
	});

	/**
	 * A row without a start timestamp cannot be swept: the write that would fail
	 * it is scoped to that exact value, so there is nothing to scope to.
	 */
	it("drops a row with no generationStartedAt", async () => {
		mocks.findStaleMock.mockResolvedValue([
			{
				id: "doc-1",
				projectId: "proj-1",
				generationStartedAt: null,
				workflowId: "wf-1",
				project: { organizationId: null },
			},
		]);

		const out = await findStaleGeneratingDocumentsActivity({
			staleAfterMinutes: 30,
			batchSize: 50,
		});

		expect(out.rows).toEqual([]);
	});

	it("reads the ceiling from env when the caller passes none", async () => {
		process.env.FABRIC_DOCUMENT_GENERATION_STALE_MINUTES = "5";
		mocks.findStaleMock.mockResolvedValue([]);
		const before = Date.now();

		await findStaleGeneratingDocumentsActivity({
			staleAfterMinutes: 0,
			batchSize: 0,
		});
		const after = Date.now();

		const { cutoff, limit } = mocks.findStaleMock.mock.calls[0][0];
		expect(limit).toBe(50);
		// The activity derives the cutoff from its own `Date.now()`, which
		// runs somewhere in [before, after] — so the cutoff lands in exactly
		// this interval. Bracketing the call pins it to the measured window
		// instead of a guessed tolerance: the band is only as wide as the
		// call actually took, so a ceiling that is off by a fraction of a
		// minute still fails. The earlier `before - cutoff >= 5 min` form was
		// unsatisfiable — that delta is `5 min - elapsed`, never above it.
		expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 5 * 60_000);
		expect(cutoff.getTime()).toBeLessThanOrEqual(after - 5 * 60_000);
	});

	/**
	 * Zero is what the workflow passes to hand the activity the decision. Read
	 * literally it would mean "everything dispatched before now", which is every
	 * in-flight generation in the deployment.
	 */
	it("never treats a zero ceiling as sweep-everything", async () => {
		mocks.findStaleMock.mockResolvedValue([]);
		const before = Date.now();

		await findStaleGeneratingDocumentsActivity({
			staleAfterMinutes: 0,
			batchSize: 50,
		});
		const after = Date.now();

		const { cutoff } = mocks.findStaleMock.mock.calls[0][0];
		// Same bracket as above, against the 30-minute default. A literal
		// zero-means-now reading would put the cutoff at roughly `after`,
		// half an hour above this interval.
		expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * 60_000);
		expect(cutoff.getTime()).toBeLessThanOrEqual(after - 30 * 60_000);
	});
});

describe("isGenerationWorkflowLiveActivity", () => {
	it("reports live while the workflow is running", async () => {
		mocks.describeMock.mockResolvedValue({ status: { name: "RUNNING" } });

		expect(
			await isGenerationWorkflowLiveActivity({ workflowId: "wf-1" }),
		).toBe(true);
	});

	it.each(["COMPLETED", "FAILED", "TERMINATED", "TIMED_OUT", "CANCELED"])(
		"reports not-live once the workflow is %s",
		async (status) => {
			mocks.describeMock.mockResolvedValue({ status: { name: status } });

			expect(
				await isGenerationWorkflowLiveActivity({ workflowId: "wf-1" }),
			).toBe(false);
		},
	);

	/**
	 * The case the sweep exists for: Temporal has never heard of this workflow,
	 * so the start genuinely never took.
	 */
	it("reports not-live when the workflow was never registered", async () => {
		const err = new Error("not found");
		err.name = "WorkflowNotFoundError";
		mocks.describeMock.mockRejectedValue(err);

		expect(
			await isGenerationWorkflowLiveActivity({ workflowId: "wf-1" }),
		).toBe(false);
	});

	it("errs toward live when Temporal cannot be reached", async () => {
		mocks.getTemporalClientMock.mockRejectedValue(new Error("no client"));

		expect(
			await isGenerationWorkflowLiveActivity({ workflowId: "wf-1" }),
		).toBe(true);
	});

	it("errs toward live on an unrecognized describe failure", async () => {
		mocks.describeMock.mockRejectedValue(new Error("connection reset"));

		expect(
			await isGenerationWorkflowLiveActivity({ workflowId: "wf-1" }),
		).toBe(true);
	});
});

describe("markGenerationTimedOutActivity", () => {
	it("scopes the write to the attempt that was scanned", async () => {
		mocks.markFailedMock.mockResolvedValue(undefined);

		await markGenerationTimedOutActivity({
			documentId: "doc-1",
			generationStartedAtMs: STARTED_AT.getTime(),
		});

		const [documentId, startedAt, message] =
			mocks.markFailedMock.mock.calls[0];
		expect(documentId).toBe("doc-1");
		expect(startedAt).toEqual(STARTED_AT);
		// Written for whoever opens the document, not for an operator.
		expect(message).toMatch(/run it again/i);
	});
});
