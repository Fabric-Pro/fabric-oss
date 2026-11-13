import { describe, expect, it } from "vitest";
import { analysisStatus } from "../ChunkingAnalysis";

describe("analysisStatus", () => {
	it("is null when nothing runs", () => {
		expect(analysisStatus({ status: "COMPLETED" }, null)).toBeNull();
	});

	it("names the step and its counts while a measure runs", () => {
		expect(
			analysisStatus(
				{
					status: "RUNNING",
					progress: { stage: "questions", done: 3, total: 12 },
				},
				null,
			),
		).toEqual({
			label: "Measuring: writing test questions, 3 of 12 sources",
			done: 3,
			total: 12,
		});
	});

	it("reads a suggestion's evaluation step", () => {
		expect(
			analysisStatus(null, {
				status: "RUNNING",
				progress: { stage: "evaluating", done: 1, total: 4 },
			})?.label,
		).toBe("Working out suggestions: testing content types, 1 of 4");
	});

	it("says it is starting before any progress is written", () => {
		expect(
			analysisStatus({ status: "RUNNING", progress: {} }, null)?.label,
		).toBe("Measuring: starting");
	});
});
