import { describe, expect, it } from "vitest";
import {
	type CheckDuplicateResult,
	checkBeforeCreate,
} from "../CreateStoryDuplicateWarning";

function result(overrides: Partial<CheckDuplicateResult> = {}) {
	return {
		decision: "create" as const,
		confidence: 0,
		alternatives: [],
		...overrides,
	};
}

describe("checkBeforeCreate", () => {
	it("warns when the check comes back enrich with a matched target", async () => {
		const enrich = result({
			decision: "enrich",
			confidence: 0.92,
			matchedStoryId: "story-1",
			matchedIdentifier: "F-12",
			matchedTitle: "Export throttling",
			reasoning: "Same work.",
			alternatives: [
				{
					storyId: "story-1",
					identifier: "F-12",
					title: "Export throttling",
					similarity: 0.9,
				},
			],
		});

		const outcome = await checkBeforeCreate(async () => enrich);

		expect(outcome).toEqual({
			kind: "warn",
			result: {
				decision: "enrich",
				confidence: 0.92,
				matchedStoryId: "story-1",
				matchedIdentifier: "F-12",
				matchedTitle: "Export throttling",
				reasoning: "Same work.",
				alternatives: enrich.alternatives,
			},
		});
	});

	it("proceeds to create, not failed, on a plain create decision", async () => {
		const outcome = await checkBeforeCreate(async () =>
			result({ decision: "create", confidence: 0.4 }),
		);

		expect(outcome).toEqual({ kind: "create", checkFailed: false });
	});

	it("proceeds to create with checkFailed when the result itself carries an error", async () => {
		const outcome = await checkBeforeCreate(async () =>
			result({ error: "Could not check for similar work items." }),
		);

		expect(outcome).toEqual({ kind: "create", checkFailed: true });
	});

	it("proceeds to create with checkFailed when the call rejects", async () => {
		const outcome = await checkBeforeCreate(async () => {
			throw new Error("network error");
		});

		expect(outcome).toEqual({ kind: "create", checkFailed: true });
	});

	it("proceeds to create with checkFailed on a client-side abort (timeout)", async () => {
		const outcome = await checkBeforeCreate(async () => {
			throw new DOMException("The operation was aborted.", "AbortError");
		});

		expect(outcome).toEqual({ kind: "create", checkFailed: true });
	});

	it("degrades to a plain create when an enrich decision names no target", async () => {
		const outcome = await checkBeforeCreate(async () =>
			result({
				decision: "enrich",
				confidence: 0.9,
				matchedStoryId: undefined,
			}),
		);

		expect(outcome).toEqual({ kind: "create", checkFailed: false });
	});
});
