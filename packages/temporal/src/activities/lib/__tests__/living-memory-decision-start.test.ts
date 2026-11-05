/**
 * The embedding hook that starts Living Memory decision extraction.
 *
 * Pins three things: only a synced, indexable, embedded row with a content
 * hash starts a run; a version that already has an extraction starts none;
 * and nothing it does can throw into the embedding that called it.
 */
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	contextFindUnique: vi.fn(),
	extractionFindUnique: vi.fn(),
	start: vi.fn(),
	getTemporalClient: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectContext: { findUnique: mocks.contextFindUnique },
		projectContextDecisionExtraction: {
			findUnique: mocks.extractionFindUnique,
		},
	},
}));

vi.mock("../../../client", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("../activity-logger", () => ({
	activityLogger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

import {
	livingMemoryDecisionWorkflowId,
	startLivingMemoryDecisionExtraction,
} from "../living-memory-decision-start";

const HASH = "a".repeat(64);

const syncedRow = {
	id: "ctx-1",
	sourcePath: "docs/decisions.md",
	contentHash: HASH,
	indexingExcluded: false,
	embeddedAt: new Date("2026-11-04T10:00:00.000Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.contextFindUnique.mockResolvedValue(syncedRow);
	mocks.extractionFindUnique.mockResolvedValue(null);
	mocks.start.mockResolvedValue({ workflowId: "wf" });
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: mocks.start },
	});
});

describe("startLivingMemoryDecisionExtraction", () => {
	it("starts one run per (context, content version) for a synced row", async () => {
		await expect(
			startLivingMemoryDecisionExtraction({ contextId: "ctx-1" }),
		).resolves.toBe("started");

		expect(mocks.start).toHaveBeenCalledWith(
			"livingMemoryDecisionExtractionWorkflow",
			expect.objectContaining({
				taskQueue: "fabric-worker",
				workflowId: livingMemoryDecisionWorkflowId("ctx-1", HASH),
				workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
				workflowIdConflictPolicy: "FAIL",
				args: [{ contextId: "ctx-1", contentHash: HASH }],
			}),
		);
		expect(livingMemoryDecisionWorkflowId("ctx-1", HASH)).toBe(
			`living-memory-decisions-ctx-1-${HASH}`,
		);
	});

	it.each([
		["a row that is not a synced file", { sourcePath: null }],
		["a store-only row", { indexingExcluded: true }],
		["a row without a content hash", { contentHash: null }],
		["a row the embedding has not confirmed", { embeddedAt: null }],
	])("starts nothing for %s", async (_label, override) => {
		mocks.contextFindUnique.mockResolvedValue({
			...syncedRow,
			...override,
		});

		await expect(
			startLivingMemoryDecisionExtraction({ contextId: "ctx-1" }),
		).resolves.toBe("not_eligible");
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("starts nothing for a deleted row", async () => {
		mocks.contextFindUnique.mockResolvedValue(null);

		await expect(
			startLivingMemoryDecisionExtraction({ contextId: "ctx-1" }),
		).resolves.toBe("not_eligible");
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("starts nothing when the version was already extracted", async () => {
		mocks.extractionFindUnique.mockResolvedValue({ id: "ext-1" });

		await expect(
			startLivingMemoryDecisionExtraction({ contextId: "ctx-1" }),
		).resolves.toBe("already_extracted");
		expect(mocks.extractionFindUnique).toHaveBeenCalledWith({
			where: {
				contextId_contentHash: {
					contextId: "ctx-1",
					contentHash: HASH,
				},
			},
			select: { id: true },
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("treats a run already open for the version as the expected answer", async () => {
		mocks.start.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"already started",
				livingMemoryDecisionWorkflowId("ctx-1", HASH),
				"livingMemoryDecisionExtractionWorkflow",
			),
		);

		await expect(
			startLivingMemoryDecisionExtraction({ contextId: "ctx-1" }),
		).resolves.toBe("already_running");
		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it("never throws: a failed read or start is logged and reported", async () => {
		mocks.getTemporalClient.mockRejectedValue(new Error("unreachable"));

		await expect(
			startLivingMemoryDecisionExtraction({ contextId: "ctx-1" }),
		).resolves.toBe("failed");

		mocks.contextFindUnique.mockRejectedValue(new Error("db down"));
		await expect(
			startLivingMemoryDecisionExtraction({ contextId: "ctx-1" }),
		).resolves.toBe("failed");
		expect(mocks.warn).toHaveBeenCalledTimes(2);
	});

	describe("a version a repository's first sync wrote", () => {
		beforeEach(() => {
			mocks.contextFindUnique.mockResolvedValue({
				...syncedRow,
				decisionScanSkippedHash: HASH,
			});
		});

		it("is not read when its embedding finishes", async () => {
			await expect(
				startLivingMemoryDecisionExtraction({ contextId: "ctx-1" }),
			).resolves.toBe("first_sync_skipped");
			expect(mocks.start).not.toHaveBeenCalled();
		});

		it("is read, without notifying, when a member asks", async () => {
			await expect(
				startLivingMemoryDecisionExtraction({
					contextId: "ctx-1",
					scanRequested: true,
				}),
			).resolves.toBe("started");
			expect(mocks.start).toHaveBeenCalledWith(
				"livingMemoryDecisionExtractionWorkflow",
				expect.objectContaining({
					args: [
						{
							contextId: "ctx-1",
							contentHash: HASH,
							notify: false,
						},
					],
				}),
			);
		});

		it("is read as usual once the file was edited", async () => {
			mocks.contextFindUnique.mockResolvedValue({
				...syncedRow,
				decisionScanSkippedHash: "b".repeat(64),
			});

			await expect(
				startLivingMemoryDecisionExtraction({ contextId: "ctx-1" }),
			).resolves.toBe("started");
			expect(mocks.start).toHaveBeenCalledWith(
				"livingMemoryDecisionExtractionWorkflow",
				expect.objectContaining({
					args: [{ contextId: "ctx-1", contentHash: HASH }],
				}),
			);
		});
	});
});
