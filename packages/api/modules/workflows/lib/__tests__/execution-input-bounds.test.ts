/**
 * The manual start accepted any `triggerData`, any `variables`, and any
 * number of node and edge bodies of any size — all of it written to the row
 * and serialised into one Temporal payload, which the engine refuses above
 * 2 MiB. These pin the ceilings and that they add up to less than that.
 */

import { describe, expect, it } from "vitest";
import {
	boundedInlineGraphSchema,
	boundedJsonRecord,
	EXECUTION_INPUT_BOUNDS,
	jsonByteLength,
} from "../execution-input-bounds";
import { MAX_WORKFLOW_NODES } from "../workflow-validation";

/** A string whose JSON serialisation is about `bytes` long. */
function blob(bytes: number): string {
	return "x".repeat(bytes);
}

describe("jsonByteLength", () => {
	it("measures the serialisation, in bytes, not the character count", () => {
		expect(jsonByteLength({ a: "é" })).toBe(Buffer.byteLength('{"a":"é"}'));
		expect(jsonByteLength(undefined)).toBe(0);
	});
});

describe("boundedJsonRecord", () => {
	const schema = boundedJsonRecord(1024, "triggerData");

	it("accepts a record under the ceiling", () => {
		expect(schema.safeParse({ ticket: "T-1" }).success).toBe(true);
	});

	it("refuses a record over the ceiling, naming the field", () => {
		const result = schema.safeParse({ payload: blob(1024) });

		expect(result.success).toBe(false);
		expect(result.error?.issues[0].message).toMatch(/triggerData/);
	});

	it("counts nested content, not only top-level keys", () => {
		const result = schema.safeParse({
			a: { b: { c: [blob(600), blob(600)] } },
		});

		expect(result.success).toBe(false);
	});
});

describe("boundedInlineGraphSchema", () => {
	it("accepts an absent graph — the stored one runs", () => {
		expect(boundedInlineGraphSchema.safeParse({}).success).toBe(true);
	});

	it("accepts a graph within every ceiling", () => {
		const graph = {
			nodes: Array.from({ length: 10 }, (_, i) => ({
				id: `n${i}`,
				type: "http-request",
				data: { url: "https://example.com" },
			})),
			edges: [{ id: "e1", source: "n0", target: "n1" }],
		};

		expect(boundedInlineGraphSchema.safeParse(graph).success).toBe(true);
	});

	it("refuses more nodes than the validator would accept, so the schema never admits what validation refuses", () => {
		expect(EXECUTION_INPUT_BOUNDS.nodes).toBe(MAX_WORKFLOW_NODES);
		const nodes = Array.from(
			{ length: MAX_WORKFLOW_NODES + 1 },
			(_, i) => ({
				id: `n${i}`,
			}),
		);

		expect(boundedInlineGraphSchema.safeParse({ nodes }).success).toBe(
			false,
		);
	});

	it("refuses one oversized node body", () => {
		const result = boundedInlineGraphSchema.safeParse({
			nodes: [
				{
					id: "n1",
					data: { config: blob(EXECUTION_INPUT_BOUNDS.nodeBytes) },
				},
			],
		});

		expect(result.success).toBe(false);
		expect(result.error?.issues[0].message).toMatch(/A node/);
	});

	it("refuses one oversized edge body", () => {
		const result = boundedInlineGraphSchema.safeParse({
			edges: [
				{ id: "e1", label: blob(EXECUTION_INPUT_BOUNDS.edgeBytes) },
			],
		});

		expect(result.success).toBe(false);
		expect(result.error?.issues[0].message).toMatch(/An edge/);
	});

	it("refuses a graph whose honest sum is over the whole-graph ceiling even though every item is under its own", () => {
		// 100 nodes of ~16 KiB each: every one under `nodeBytes`, the sum
		// over `graphBytes`.
		const nodes = Array.from({ length: 100 }, (_, i) => ({
			id: `n${i}`,
			data: { config: blob(16 * 1024) },
		}));

		const result = boundedInlineGraphSchema.safeParse({ nodes });

		expect(result.success).toBe(false);
		expect(
			result.error?.issues.some((i) => /posted graph/.test(i.message)),
		).toBe(true);
	});
});

describe("the ceilings add up to less than one Temporal payload", () => {
	it("keeps the worst-case start argument under the 2 MiB payload limit", () => {
		const TEMPORAL_PAYLOAD_LIMIT = 2 * 1024 * 1024;
		const worstCase =
			EXECUTION_INPUT_BOUNDS.triggerDataBytes +
			EXECUTION_INPUT_BOUNDS.variablesBytes +
			EXECUTION_INPUT_BOUNDS.graphBytes;

		expect(worstCase).toBeLessThan(TEMPORAL_PAYLOAD_LIMIT);
	});
});
