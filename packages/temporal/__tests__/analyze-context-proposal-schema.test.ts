/**
 * `ChangeProposalSchema` is the analyzer's GENERATION schema — the shape
 * `generateObject` forces the model into. A field that is required here is a
 * field the whole run dies on.
 *
 * Found on staging 18 Aug 2026 (Fizzy #2170 acceptance run): 3 of 9 live AI
 * Update executions died with
 *
 *   ZodError: expected "string", code "invalid_type",
 *             path ["changes", 0, "reasoning"]
 *
 * `reasoning` and `sourceContext` are narrative annotations. Every consumer
 * already guards them — `change.reasoning ? … : ""` in `structurePreserveUpdates`
 * and `applyBacklogChanges`, and `routing.reasoning` is already
 * `.nullable().optional()`. Only the generation schema treated them as
 * load-bearing, so one omitted sentence discarded every other valid change in
 * the same response.
 *
 * These tests pin the asymmetry shut: the schema must accept a change that
 * carries no annotation, and must still reject a change missing something the
 * apply path genuinely cannot work without.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/analyze-context-proposal-schema.test.ts
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChangeProposalSchema } from "../src/activities/backlog-context/analyze-context";

/** Drop keys without binding an unused name for each one. */
function omit(source: Record<string, unknown>, ...keys: string[]) {
	const copy = { ...source };
	for (const key of keys) {
		delete copy[key];
	}
	return copy;
}

/** A change carrying only what the apply path actually requires. */
function minimalChange(overrides: Record<string, unknown> = {}) {
	return {
		type: "feature",
		action: "create",
		title: "Add a retry to the ingest worker",
		reasoning: "The meeting called out repeated ingest timeouts.",
		sourceContext: "meeting_transcript",
		...overrides,
	};
}

describe("ChangeProposalSchema", () => {
	it("accepts a change whose reasoning the model omitted", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [omit(minimalChange(), "reasoning")],
		});

		expect(result.success).toBe(true);
	});

	it("accepts a change whose reasoning the model returned as null", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [minimalChange({ reasoning: null })],
		});

		expect(result.success).toBe(true);
	});

	it("accepts a change whose sourceContext the model omitted", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [omit(minimalChange(), "sourceContext")],
		});

		expect(result.success).toBe(true);
	});

	it("keeps every other change when one of them carries no reasoning", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [
				minimalChange(),
				omit(minimalChange({ title: "Second item" }), "reasoning"),
			],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(2);
	});

	// This asserted a REJECTED parse when it was written. The contract changed
	// deliberately: a change the apply path cannot use is now dropped rather
	// than rejecting the whole response with it. The intent is unchanged — such
	// a change must never reach the apply path — so the assertion moved from
	// "the parse fails" to "the change is not in the result".
	it("does not let a change with no title through to the apply path", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [omit(minimalChange(), "title")],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(0);
	});
});

/**
 * One malformed element must not cost the whole response.
 *
 * The 18 Aug fix made `reasoning` and `sourceContext` optional, which removed
 * ONE instance of a class: `generateObject` validates the entire response, so
 * anything the model gets wrong anywhere in `changes` rejects the lot — every
 * valid change in the same response included.
 *
 * The regression run that evening proved the class was still open, with a
 * different shape entirely:
 *
 *   ZodError: expected "object", code "invalid_type", path ["changes", 1]
 *
 * No amount of per-field relaxation can enumerate every way a model might
 * malform an element. So the array drops what it cannot use and keeps the rest.
 *
 * The array ITSELF stays strict on purpose: a response carrying no `changes` at
 * all is a wholesale generation failure, and quietly reporting "0 proposed"
 * would hide it. Only individual elements are salvageable.
 */
describe("ChangeProposalSchema — salvaging a partly malformed response", () => {
	it("keeps the valid changes when one element is not an object at all", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [minimalChange(), null, minimalChange({ title: "Third" })],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(2);
	});

	it("keeps the valid changes when one element is a bare string", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [minimalChange(), "just some prose the model emitted"],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(1);
	});

	it("drops an element whose own fields do not validate", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [
				minimalChange(),
				omit(minimalChange({ title: "No title here" }), "title"),
			],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(1);
	});

	it("drops an element whose type is outside the supported set", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [minimalChange(), minimalChange({ type: "saga" })],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(1);
	});

	it("returns an empty list rather than throwing when every element is unusable", () => {
		const result = ChangeProposalSchema.safeParse({ changes: [null, 42] });

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(0);
	});

	it("still rejects a response carrying no changes array at all", () => {
		expect(ChangeProposalSchema.safeParse({}).success).toBe(false);
		expect(
			ChangeProposalSchema.safeParse({ changes: "nope" }).success,
		).toBe(false);
	});
});

/**
 * Fizzy #2395: prod logged the array arriving double-encoded — `changes` as a
 * JSON string rather than a list. The content was fine; only the packaging was
 * wrong, and rejecting it cost the entire run.
 *
 * A missing `changes` stays a rejection. The distinction is the point: one is a
 * provider encoding the right answer twice, the other is the model failing to
 * answer at all, and defaulting the second to `[]` would report "0 proposed"
 * for a run that generated nothing.
 */
describe("ChangeProposalSchema — a double-encoded changes array", () => {
	it("parses a changes array the model returned as a JSON string", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: JSON.stringify([
				minimalChange(),
				minimalChange({ title: "Second item" }),
			]),
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(2);
		expect(result.data?.changes[0]?.title?.to).toBe(minimalChange().title);
	});

	it("still drops the unusable elements inside a JSON-string array", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: JSON.stringify([minimalChange(), null, 42]),
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(1);
	});

	it("rejects a string that is not JSON at all", () => {
		expect(
			ChangeProposalSchema.safeParse({
				changes: "I could not find anything to propose.",
			}).success,
		).toBe(false);
	});

	it("rejects a JSON string that does not hold an array", () => {
		expect(
			ChangeProposalSchema.safeParse({
				changes: JSON.stringify({ changes: [] }),
			}).success,
		).toBe(false);
		expect(ChangeProposalSchema.safeParse({ changes: "42" }).success).toBe(
			false,
		);
	});

	it("does not turn a missing changes into an empty proposal", () => {
		expect(ChangeProposalSchema.safeParse({}).success).toBe(false);
	});
});

/**
 * The salvage wraps `changes` in `z.preprocess`, and this schema is not only a
 * validator — the AI SDK converts it to JSON Schema to TELL the model what to
 * produce. A wrapper that flattened the element shape would still pass every
 * test above while quietly degrading generation, which is the failure mode that
 * produced the malformed elements in the first place.
 */
describe("the JSON Schema the model is handed", () => {
	it("still describes each change's fields through the preprocess wrapper", () => {
		const json = z.toJSONSchema(ChangeProposalSchema, {
			io: "input",
		}) as Record<string, any>;
		const changes = json.properties?.changes;

		expect(changes?.type).toBe("array");
		expect(changes?.items?.type).toBe("object");
		expect(Object.keys(changes?.items?.properties ?? {})).toEqual(
			expect.arrayContaining([
				"type",
				"action",
				"title",
				"reasoning",
				"sourceContext",
			]),
		);
	});
});
