import { describe, expect, it } from "vitest";
import {
	GENERATION_RUN_SILENCE_CEILING_MS,
	isGenerationOwnedStatus,
	isGenerationRunStillWriting,
	isRunGuardedDocumentType,
} from "../generation-run-guard";

describe("isRunGuardedDocumentType", () => {
	it("guards a Proposal, with no rollout gate to consult", () => {
		expect(isRunGuardedDocumentType("PROPOSAL")).toBe(true);
	});

	it.each(["PRD", "SRS", "BUSINESS_CASE", "INTEGRATION_CONTRACT", ""])(
		"leaves %s unguarded",
		(type) => {
			expect(isRunGuardedDocumentType(type)).toBe(false);
		},
	);
});

describe("isGenerationOwnedStatus", () => {
	it.each(["QUEUED", "GENERATING"])(
		"reserves %s for generation runs",
		(status) => {
			expect(isGenerationOwnedStatus(status)).toBe(true);
		},
	);

	it.each(["DRAFT", "COMPLETE", "FAILED", undefined, null])(
		"lets a caller send %s",
		(status) => {
			expect(isGenerationOwnedStatus(status)).toBe(false);
		},
	);
});

describe("isGenerationRunStillWriting", () => {
	const NOW = Date.parse("2026-10-20T12:00:00.000Z");
	const ago = (ms: number) => new Date(NOW - ms);

	it("holds the silence ceiling at ten minutes", () => {
		expect(GENERATION_RUN_SILENCE_CEILING_MS).toBe(10 * 60 * 1000);
	});

	it("counts a queued run as writing at any age", () => {
		expect(
			isGenerationRunStillWriting(
				{
					status: "QUEUED",
					generationStartedAt: ago(5 * 60 * 60 * 1000),
					updatedAt: ago(5 * 60 * 60 * 1000),
				},
				NOW,
			),
		).toBe(true);
	});

	it("counts a generating run as writing up to the ceiling, and stalled after it", () => {
		const at = (silentForMs: number) =>
			isGenerationRunStillWriting(
				{ status: "GENERATING", updatedAt: ago(silentForMs) },
				NOW,
			);

		expect(at(0)).toBe(true);
		expect(at(GENERATION_RUN_SILENCE_CEILING_MS)).toBe(true);
		expect(at(GENERATION_RUN_SILENCE_CEILING_MS + 1)).toBe(false);
	});

	it("judges a generating run by its last write, not by when it was accepted", () => {
		// Accepted an hour ago after a long context wait, written to a
		// minute ago: still writing.
		expect(
			isGenerationRunStillWriting(
				{
					status: "GENERATING",
					generationStartedAt: ago(60 * 60 * 1000),
					updatedAt: ago(60 * 1000).toISOString(),
				},
				NOW,
			),
		).toBe(true);
	});

	it("falls back to the accepted-at stamp, then to now", () => {
		expect(
			isGenerationRunStillWriting(
				{
					status: "GENERATING",
					generationStartedAt: ago(11 * 60 * 1000),
					updatedAt: null,
				},
				NOW,
			),
		).toBe(false);
		expect(isGenerationRunStillWriting({ status: "GENERATING" }, NOW)).toBe(
			true,
		);
	});

	it.each(["COMPLETE", "DRAFT", "FAILED", "IN_PROGRESS", ""])(
		"holds no run in %s",
		(status) => {
			expect(
				isGenerationRunStillWriting({ status, updatedAt: ago(0) }, NOW),
			).toBe(false);
		},
	);
});
