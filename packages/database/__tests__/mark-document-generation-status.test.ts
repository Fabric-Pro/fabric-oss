/**
 * `markDocumentGenerationStarted` / `markDocumentGenerationFailed` — the
 * GENERATING/FAILED status writes the generate-document procedure makes
 * around a Temporal workflow start (issue #720).
 *
 * `markDocumentGenerationFailed` pins the mechanism, not just the outcome:
 * the write is attempt-scoped via a guarded `updateMany` WHERE clause
 * (status + generationStartedAt), not a bare `update` by id. `workflow.start`
 * can throw even though Temporal actually accepted the start (a lost
 * response), and a delayed failing request can resolve after a newer
 * attempt has already re-marked the row — the guard is what stops that
 * stale request from clobbering the newer attempt's state. A naive outcome
 * test (mock resolves, assert FAILED) would pass an unguarded `update`
 * implementation too and still miss the race.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { update, updateMany } = vi.hoisted(() => ({
	update: vi.fn(),
	updateMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: { projectDocument: { update, updateMany } },
}));

import {
	markDocumentGenerationFailed,
	markDocumentGenerationStarted,
} from "../prisma/queries/projects/documents";

const DOCUMENT_ID = "doc-1";
const STARTED_AT = new Date("2026-08-16T00:00:00.000Z");

beforeEach(() => {
	update.mockReset();
	updateMany.mockReset();
	update.mockResolvedValue({
		id: DOCUMENT_ID,
		status: "GENERATING",
		generationProgress: 0,
		generationError: null,
		generationStartedAt: STARTED_AT,
	});
	updateMany.mockResolvedValue({ count: 1 });
});

describe("markDocumentGenerationStarted", () => {
	it("writes GENERATING, resets progress, clears the error, and stamps generationStartedAt", async () => {
		await markDocumentGenerationStarted(DOCUMENT_ID);

		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith({
			where: { id: DOCUMENT_ID },
			data: {
				status: "GENERATING",
				generationProgress: 0,
				generationError: null,
				generationStartedAt: expect.any(Date),
			},
		});
	});

	it("returns the updated row so the caller can capture this attempt's generationStartedAt identity", async () => {
		const result = await markDocumentGenerationStarted(DOCUMENT_ID);
		expect(result.generationStartedAt).toEqual(STARTED_AT);
	});
});

describe("markDocumentGenerationFailed", () => {
	it("writes FAILED + the error via a guarded updateMany, not an unconditional update", async () => {
		await markDocumentGenerationFailed(
			DOCUMENT_ID,
			STARTED_AT,
			"Failed to start document generation",
		);

		expect(update).not.toHaveBeenCalled();
		expect(updateMany).toHaveBeenCalledTimes(1);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: DOCUMENT_ID,
				status: "GENERATING",
				generationStartedAt: STARTED_AT,
			},
			data: {
				status: "FAILED",
				generationError: "Failed to start document generation",
			},
		});
	});

	it("is a silent no-op when a newer attempt already moved the row off this exact GENERATING/startedAt state", async () => {
		// Simulates the race: a second, newer attempt re-marked the row
		// (fresh generationStartedAt, or the workflow itself progressed the
		// status) before this stale request's write lands.
		updateMany.mockResolvedValue({ count: 0 });

		await expect(
			markDocumentGenerationFailed(
				DOCUMENT_ID,
				STARTED_AT,
				"Failed to start document generation",
			),
		).resolves.toBeUndefined();

		expect(updateMany).toHaveBeenCalledTimes(1);
		expect(update).not.toHaveBeenCalled();
	});
});
