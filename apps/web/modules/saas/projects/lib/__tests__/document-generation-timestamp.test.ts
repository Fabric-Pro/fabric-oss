import { describe, expect, it } from "vitest";
import {
	isDocumentGenerationStale,
	resolveGenerationClock,
} from "../document-generation-timestamp";

describe("resolveGenerationClock", () => {
	it("measures a queued document from generationStartedAt, the accepted-at stamp", () => {
		const startedAt = new Date("2026-09-06T12:00:00.000Z");
		const updatedAt = new Date("2026-09-06T12:05:00.000Z");
		expect(resolveGenerationClock("QUEUED", startedAt, updatedAt)).toBe(
			startedAt.getTime(),
		);
	});

	it("accepts an ISO string for the queued clock", () => {
		const startedAt = "2026-09-06T12:00:00.000Z";
		const updatedAt = "2026-09-06T12:05:00.000Z";
		expect(resolveGenerationClock("QUEUED", startedAt, updatedAt)).toBe(
			new Date(startedAt).getTime(),
		);
	});

	it("falls the queued clock back to updatedAt when there is no accepted-at stamp", () => {
		const updatedAt = new Date("2026-09-06T12:05:00.000Z");
		expect(resolveGenerationClock("QUEUED", null, updatedAt)).toBe(
			updatedAt.getTime(),
		);
		expect(resolveGenerationClock("QUEUED", undefined, updatedAt)).toBe(
			updatedAt.getTime(),
		);
		expect(
			resolveGenerationClock("QUEUED", null, "2026-09-06T12:05:00.000Z"),
		).toBe(updatedAt.getTime());
	});

	/**
	 * The distinction the whole helper exists for. `generationStartedAt` is
	 * stamped when the request is ACCEPTED — it is the attempt's identity, and
	 * the server's guarded writes compare against it, so it is never refreshed
	 * when the model call finally begins. Measuring a run under way by it makes
	 * a document that waited an hour on the project's context work look an hour
	 * dead the instant it starts producing output.
	 */
	it("measures a generating document from updatedAt, the last server write", () => {
		const acceptedAt = new Date("2026-09-06T11:00:00.000Z");
		const lastWrite = new Date("2026-09-06T12:05:00.000Z");
		expect(
			resolveGenerationClock("GENERATING", acceptedAt, lastWrite),
		).toBe(lastWrite.getTime());
	});

	it("falls the generating clock back to generationStartedAt when nothing has been written yet", () => {
		const acceptedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(resolveGenerationClock("GENERATING", acceptedAt, null)).toBe(
			acceptedAt.getTime(),
		);
		expect(
			resolveGenerationClock("GENERATING", acceptedAt, undefined),
		).toBe(acceptedAt.getTime());
	});

	it("treats every non-queued status the way it treats GENERATING", () => {
		const acceptedAt = new Date("2026-09-06T11:00:00.000Z");
		const lastWrite = new Date("2026-09-06T12:05:00.000Z");
		for (const status of [undefined, null, "", "COMPLETE", "FAILED"]) {
			expect(resolveGenerationClock(status, acceptedAt, lastWrite)).toBe(
				lastWrite.getTime(),
			);
		}
	});

	it("defaults to approximately Date.now() when both columns are null or undefined", () => {
		const before = Date.now();
		const result = resolveGenerationClock("GENERATING", null, null);
		const after = Date.now();

		expect(result).toBeGreaterThanOrEqual(before);
		expect(result).toBeLessThanOrEqual(after);
		expect(
			resolveGenerationClock("QUEUED", null, null),
		).toBeGreaterThanOrEqual(before);
	});
});

describe("isDocumentGenerationStale", () => {
	it("returns false if elapsed time is under 3 minutes (180s)", () => {
		const now = new Date("2026-09-06T12:02:59.000Z").getTime();
		const updatedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(
			isDocumentGenerationStale("GENERATING", null, updatedAt, now),
		).toBe(false);
	});

	it("returns false if elapsed time is exactly 3 minutes (180s)", () => {
		const now = new Date("2026-09-06T12:03:00.000Z").getTime();
		const updatedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(
			isDocumentGenerationStale("GENERATING", null, updatedAt, now),
		).toBe(false);
	});

	it("returns true if elapsed time exceeds 3 minutes", () => {
		const now = new Date("2026-09-06T12:03:01.000Z").getTime();
		const updatedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(
			isDocumentGenerationStale("GENERATING", null, updatedAt, now),
		).toBe(true);
	});

	it("returns true for a GENERATING document silent for four minutes", () => {
		const now = new Date("2026-09-06T12:04:00.000Z").getTime();
		const updatedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(
			isDocumentGenerationStale("GENERATING", null, updatedAt, now),
		).toBe(true);
	});

	/**
	 * The regression this threshold's clock was changed for. The request was
	 * accepted an hour ago and spent that hour queued behind the project's
	 * context work; the model call has only just started and is writing. It is
	 * the healthiest possible run, and the accepted-at stamp called it stalled.
	 */
	it("does not call a run stalled for the hour it spent waiting to start", () => {
		const now = new Date("2026-09-06T13:00:00.000Z").getTime();
		const acceptedAt = new Date("2026-09-06T12:00:00.000Z");
		const lastWrite = new Date("2026-09-06T12:59:50.000Z");
		expect(
			isDocumentGenerationStale("GENERATING", acceptedAt, lastWrite, now),
		).toBe(false);
	});

	/**
	 * The reason the status is a parameter at all. A queued document is waiting
	 * on the project's context-building work before its model call may start,
	 * and that wait can legitimately last an hour — judging it by elapsed time
	 * would offer a "Retry" that only restarts the wait it interrupted.
	 */
	it("returns false for a QUEUED document an hour old", () => {
		const now = new Date("2026-09-06T13:00:00.000Z").getTime();
		const startedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(isDocumentGenerationStale("QUEUED", startedAt, null, now)).toBe(
			false,
		);
	});

	it("evaluates staleness using fallback generationStartedAt when nothing has been written yet", () => {
		const now = new Date("2026-09-06T12:05:00.000Z").getTime();
		const acceptedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(
			isDocumentGenerationStale("GENERATING", acceptedAt, null, now),
		).toBe(true);
	});

	it("still judges by elapsed time when the status is unknown", () => {
		const now = new Date("2026-09-06T12:05:00.000Z").getTime();
		const updatedAt = new Date("2026-09-06T12:00:00.000Z");
		expect(isDocumentGenerationStale(undefined, null, updatedAt, now)).toBe(
			true,
		);
	});
});
