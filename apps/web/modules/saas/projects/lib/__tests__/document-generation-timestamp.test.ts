import { describe, expect, it } from "vitest";
import {
	isDocumentGenerationStale,
	resolveGenerationTimestamp,
} from "../document-generation-timestamp";

describe("resolveGenerationTimestamp", () => {
	it("uses generationStartedAt Date object when provided", () => {
		const startedAt = new Date("2026-09-06T12:00:00.000Z");
		const updatedAt = new Date("2026-09-06T12:05:00.000Z");
		expect(resolveGenerationTimestamp(startedAt, updatedAt)).toBe(
			startedAt.getTime(),
		);
	});

	it("uses generationStartedAt ISO string when provided", () => {
		const startedAt = "2026-09-06T12:00:00.000Z";
		const updatedAt = "2026-09-06T12:05:00.000Z";
		expect(resolveGenerationTimestamp(startedAt, updatedAt)).toBe(
			new Date(startedAt).getTime(),
		);
	});

	it("falls back to updatedAt when generationStartedAt is null or undefined", () => {
		const updatedAt = new Date("2026-09-06T12:05:00.000Z");
		expect(resolveGenerationTimestamp(null, updatedAt)).toBe(
			updatedAt.getTime(),
		);
		expect(resolveGenerationTimestamp(undefined, updatedAt)).toBe(
			updatedAt.getTime(),
		);
	});

	it("falls back to updatedAt ISO string when generationStartedAt is null", () => {
		const updatedAt = "2026-09-06T12:05:00.000Z";
		expect(resolveGenerationTimestamp(null, updatedAt)).toBe(
			new Date(updatedAt).getTime(),
		);
	});

	it("defaults to approximately Date.now() when both parameters are null or undefined", () => {
		const before = Date.now();
		const result = resolveGenerationTimestamp(null, null);
		const after = Date.now();

		expect(result).toBeGreaterThanOrEqual(before);
		expect(result).toBeLessThanOrEqual(after);
	});
});

describe("isDocumentGenerationStale", () => {
	it("returns false if elapsed time is under 3 minutes (180s)", () => {
		const now = new Date("2026-09-06T12:02:59.000Z").getTime();
		const startedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(isDocumentGenerationStale(startedAt, null, now)).toBe(false);
	});

	it("returns false if elapsed time is exactly 3 minutes (180s)", () => {
		const now = new Date("2026-09-06T12:03:00.000Z").getTime();
		const startedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(isDocumentGenerationStale(startedAt, null, now)).toBe(false);
	});

	it("returns true if elapsed time exceeds 3 minutes", () => {
		const now = new Date("2026-09-06T12:03:01.000Z").getTime();
		const startedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(isDocumentGenerationStale(startedAt, null, now)).toBe(true);
	});

	it("evaluates staleness using fallback updatedAt when generationStartedAt is null", () => {
		const now = new Date("2026-09-06T12:05:00.000Z").getTime();
		const updatedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(isDocumentGenerationStale(null, updatedAt, now)).toBe(true);
	});
});
