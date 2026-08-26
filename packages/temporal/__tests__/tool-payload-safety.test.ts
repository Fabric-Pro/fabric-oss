import { describe, expect, it } from "vitest";
import {
	capToolSet,
	validateMcpToolSet,
} from "../src/activities/direct-chat/tool-payload-safety";

const tool = (schema: unknown) => ({
	description: "x",
	inputSchema: schema,
	execute: async () => ({}),
});

describe("validateMcpToolSet", () => {
	it("keeps tools with a plain object schema", () => {
		const input = { a: tool({ type: "object", properties: {} }) };
		const { tools, dropped } = validateMcpToolSet(input);
		expect(Object.keys(tools)).toEqual(["a"]);
		expect(dropped).toEqual([]);
	});

	it("drops tools whose schema contains $ref", () => {
		const input = {
			ok: tool({ type: "object", properties: {} }),
			bad: tool({
				type: "object",
				properties: { x: { $ref: "#/defs/X" } },
			}),
		};
		const { tools, dropped } = validateMcpToolSet(input);
		expect(Object.keys(tools)).toEqual(["ok"]);
		expect(dropped).toEqual([
			{ name: "bad", reason: "schema_contains_ref" },
		]);
	});

	it("drops tools whose schema is not JSON-serializable", () => {
		const circular: Record<string, unknown> = { type: "object" };
		circular.self = circular;
		const input = { bad: tool(circular) };
		const { tools, dropped } = validateMcpToolSet(input);
		expect(Object.keys(tools)).toEqual([]);
		expect(dropped[0]).toEqual({
			name: "bad",
			reason: "schema_not_serializable",
		});
	});

	// Finding #5: structural $ref detection must not false-positive on string
	// values or descriptions that merely contain the text "$ref".
	it('keeps a tool whose schema has a string description containing the text "$ref" but no actual $ref key', () => {
		const input = {
			ok: tool({
				type: "object",
				properties: {
					x: { type: "string", description: 'use the "$ref" field' },
				},
			}),
		};
		const { tools, dropped } = validateMcpToolSet(input);
		expect(Object.keys(tools)).toEqual(["ok"]);
		expect(dropped).toEqual([]);
	});

	// Finding #8: validateMcpToolSet must return a sizes map for kept tools.
	it("returns sizes with a numeric byte length for each kept tool", () => {
		const input = {
			a: tool({ type: "object", properties: {} }),
			b: tool({ type: "object", properties: { x: { type: "string" } } }),
		};
		const { tools, sizes } = validateMcpToolSet(input);
		expect(Object.keys(tools)).toEqual(["a", "b"]);
		expect(typeof sizes.a).toBe("number");
		expect(sizes.a).toBeGreaterThan(0);
		expect(typeof sizes.b).toBe("number");
		expect(sizes.b).toBeGreaterThan(sizes.a);
	});
});

describe("capToolSet", () => {
	const many = (n: number) =>
		Object.fromEntries(
			Array.from({ length: n }, (_, i) => [
				`t${i}`,
				tool({ type: "object", properties: {} }),
			]),
		);

	it("returns all tools when under the count limit", () => {
		const { tools, dropped } = capToolSet(many(3), {
			maxTools: 10,
			maxTotalSchemaBytes: 100_000,
		});
		expect(Object.keys(tools)).toHaveLength(3);
		expect(dropped).toEqual([]);
	});

	it("drops tools beyond the count limit", () => {
		const { tools, dropped } = capToolSet(many(5), {
			maxTools: 2,
			maxTotalSchemaBytes: 100_000,
		});
		expect(Object.keys(tools)).toHaveLength(2);
		expect(dropped).toHaveLength(3);
		expect(dropped.every((d) => d.reason === "over_tool_budget")).toBe(
			true,
		);
	});

	it("always keeps pinned tools even when over the limit", () => {
		const input = {
			...many(5),
			keepme: tool({ type: "object", properties: {} }),
		};
		const { tools } = capToolSet(input, {
			maxTools: 1,
			maxTotalSchemaBytes: 100_000,
			alwaysKeep: (name) => name === "keepme",
		});
		expect(Object.keys(tools)).toContain("keepme");
	});

	// Finding #8: capToolSet must honor precomputedBytes and use them when
	// enforcing the byte budget, avoiding a second serialization pass.
	it("honors precomputedBytes when enforcing the byte budget", () => {
		// Two tools each with a small schema (~30 bytes). We lie with
		// precomputedBytes, telling capToolSet that t0 costs 1000 bytes.
		// With maxTotalSchemaBytes=999, t0 should be dropped immediately.
		const input = many(2);
		const { sizes } = validateMcpToolSet(input);
		// Override t0's size to something artificially large
		const precomputedBytes = { ...sizes, t0: 1000 };
		const { tools, dropped } = capToolSet(input, {
			maxTools: 10,
			maxTotalSchemaBytes: 999,
			precomputedBytes,
		});
		expect(Object.keys(tools)).not.toContain("t0");
		expect(
			dropped.some(
				(d) => d.name === "t0" && d.reason === "over_tool_budget",
			),
		).toBe(true);
	});
});
