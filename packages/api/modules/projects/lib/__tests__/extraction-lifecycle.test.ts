import { describe, expect, it } from "vitest";
import {
	hasExtractionLifecycle,
	withExtractionLifecycleOrSettled,
} from "../extraction-lifecycle";

describe("hasExtractionLifecycle", () => {
	it("is true for every non-integration kind", () => {
		for (const type of ["FILE", "LINK", "TEXT", "MEETING_TRANSCRIPT"]) {
			expect(hasExtractionLifecycle({ type, metadata: null })).toBe(true);
		}
	});

	it("is false for a live integration, whose status never moves", () => {
		expect(
			hasExtractionLifecycle({
				type: "INTEGRATION",
				metadata: { provider: "SLACK" },
			}),
		).toBe(false);
		expect(
			hasExtractionLifecycle({ type: "INTEGRATION", metadata: null }),
		).toBe(false);
	});

	it("is true for a Google Doc, which runs the full pipeline", () => {
		expect(
			hasExtractionLifecycle({
				type: "INTEGRATION",
				metadata: { source: "google-docs" },
			}),
		).toBe(true);
	});
});

describe("withExtractionLifecycleOrSettled", () => {
	it("is a positive OR, so a settled integration row still counts", () => {
		expect(withExtractionLifecycleOrSettled()).toEqual({
			OR: [
				{ type: { not: "INTEGRATION" } },
				{ extractionStatus: { notIn: ["PENDING", "EXTRACTING"] } },
				{ metadata: { path: ["source"], equals: "google-docs" } },
			],
		});
	});

	it("hands every caller its own arrays", () => {
		const first = withExtractionLifecycleOrSettled();
		const second = withExtractionLifecycleOrSettled();
		expect(first.OR).not.toBe(second.OR);
		expect(first.OR[1]).not.toBe(second.OR[1]);
	});
});
