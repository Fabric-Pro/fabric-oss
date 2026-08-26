import { shouldStartInsightExtraction } from "@repo/api/modules/projects/procedures/meeting-digest/extract-insights";
import { MEETING_INSIGHTS_VERSION } from "@repo/temporal/activities";
import { describe, expect, it } from "vitest";

describe("shouldStartInsightExtraction", () => {
	const base = {
		contextId: "ctx1",
		contentLength: 1200 as number | null,
		summary: null as string | null,
		insightsExtractedAt: null as Date | null,
		insightsVersion: null as number | null,
	};

	it("starts when insights were never extracted and a transcript body exists", () => {
		expect(shouldStartInsightExtraction(base)).toBe(true);
	});

	it("starts when the cached insights are from a stale version", () => {
		expect(
			shouldStartInsightExtraction({
				...base,
				insightsExtractedAt: new Date("2026-07-01T00:00:00Z"),
				insightsVersion: MEETING_INSIGHTS_VERSION - 1,
			}),
		).toBe(true);
	});

	it("does not start when the cache is current", () => {
		expect(
			shouldStartInsightExtraction({
				...base,
				insightsExtractedAt: new Date("2026-07-01T00:00:00Z"),
				insightsVersion: MEETING_INSIGHTS_VERSION,
			}),
		).toBe(false);
	});

	it("does not start when there is no text source at all", () => {
		expect(
			shouldStartInsightExtraction({
				...base,
				contextId: null,
				contentLength: null,
			}),
		).toBe(false);
	});

	it("does not start when the context body is known-empty", () => {
		expect(
			shouldStartInsightExtraction({ ...base, contentLength: 0 }),
		).toBe(false);
	});

	it("starts when contentLength is legacy-unknown (null)", () => {
		expect(
			shouldStartInsightExtraction({ ...base, contentLength: null }),
		).toBe(true);
	});

	it("falls back to the stored summary as a text source", () => {
		expect(
			shouldStartInsightExtraction({
				...base,
				contextId: null,
				contentLength: null,
				summary: "sync-time summary",
			}),
		).toBe(true);
	});

	it("shouldStartInsightExtraction returns true for a fresh cache when force is set", () => {
		expect(
			shouldStartInsightExtraction(
				{
					contextId: "ctx1",
					contentLength: 100,
					summary: "s",
					insightsExtractedAt: new Date(),
					insightsVersion: MEETING_INSIGHTS_VERSION,
				},
				{ force: true },
			),
		).toBe(true);
	});

	it("force does not override the no-text-source guard", () => {
		expect(
			shouldStartInsightExtraction(
				{
					contextId: null,
					contentLength: null,
					summary: null,
					insightsExtractedAt: null,
					insightsVersion: null,
				},
				{ force: true },
			),
		).toBe(false);
	});
});
