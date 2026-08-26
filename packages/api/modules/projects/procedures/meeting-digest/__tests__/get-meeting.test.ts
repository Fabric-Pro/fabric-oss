/**
 * Focused unit tests for the pure `toActionItemPayload` mapper (#1896 Task 3).
 *
 * Asserts that `sourceQuote`/`anchorLine` survive both the first-class-row
 * branch and the legacy-JSON fallback branch, including type coercion of
 * malformed legacy JSON.
 */
import { describe, expect, it } from "vitest";
import { toActionItemPayload } from "../get-meeting";

describe("toActionItemPayload anchor fields (#1896 Task 3)", () => {
	it("passes anchor fields through from rows", () => {
		const out = toActionItemPayload({
			rows: [
				{
					id: "a",
					orderIndex: 0,
					text: "Ship it",
					tentativeOwnerName: null,
					dueHint: null,
					completedAt: null,
					sourceQuote: "we ship it",
					anchorLine: 12,
				},
			],
			legacyJson: null,
		});
		expect(out[0]).toMatchObject({
			sourceQuote: "we ship it",
			anchorLine: 12,
		});
	});

	it("legacy-JSON coerces bad anchor types to null", () => {
		const out = toActionItemPayload({
			rows: [],
			legacyJson: [{ text: "x", anchorLine: "12" }],
		});
		expect(out[0]).toMatchObject({ sourceQuote: null, anchorLine: null });
	});

	it("legacy-JSON passes through well-typed anchor fields", () => {
		const out = toActionItemPayload({
			rows: [],
			legacyJson: [
				{ text: "x", sourceQuote: "quoted text", anchorLine: 7 },
			],
		});
		expect(out[0]).toMatchObject({
			sourceQuote: "quoted text",
			anchorLine: 7,
		});
	});
});
