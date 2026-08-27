import { describe, expect, it } from "vitest";
import {
	capToolSet,
	summarizeOmittedTools,
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

// Fizzy #2040: a user selected four MCP servers, the request carried all four
// ids, and two of them reached the model with no tools at all — the budget was
// spent in iteration order by whichever config sorted first. The deck still
// reported them as active, so the model truthfully answered that it had no
// tool for the job and the user read that as "the server is not connected".
describe("capToolSet — sharing the budget between servers", () => {
	// One tool per server, each ~120 bytes of schema, so the budget is what
	// bites rather than the count cap.
	const serverTools = (server: string, n: number) =>
		Object.fromEntries(
			Array.from({ length: n }, (_, i) => [
				`${server}_t${i}`,
				tool({
					type: "object",
					properties: {
						padding: {
							type: "string",
							description: "x".repeat(80),
						},
					},
				}),
			]),
		);
	const groupOf = (name: string) => name.split("_")[0] as string;
	const fourServers = {
		...serverTools("first", 12),
		...serverTools("second", 12),
		...serverTools("third", 12),
		...serverTools("fourth", 12),
	};
	// Deliberately too small for all 48 tools, so something must be dropped.
	const budget = { maxTools: 48, maxTotalSchemaBytes: 1_500 };

	it("starves the later servers without grouping — the reported bug", () => {
		const { tools } = capToolSet(fourServers, budget);
		const servers = new Set(Object.keys(tools).map(groupOf));
		expect(servers.has("first")).toBe(true);
		expect(servers.has("fourth")).toBe(false);
	});

	it("gives every server tools when grouped, on the same budget", () => {
		const { tools, dropped } = capToolSet(fourServers, {
			...budget,
			groupOf,
		});
		const servers = new Set(Object.keys(tools).map(groupOf));
		expect([...servers].sort()).toEqual([
			"first",
			"fourth",
			"second",
			"third",
		]);
		// Still a cap, and still reported rather than silently applied.
		expect(dropped.length).toBeGreaterThan(0);
		expect(dropped.every((d) => d.reason === "over_tool_budget")).toBe(
			true,
		);
	});

	it("keeps a server whose own tools would exhaust the whole budget from taking it", () => {
		const input = {
			...serverTools("greedy", 40),
			...serverTools("modest", 2),
		};
		const { tools } = capToolSet(input, { ...budget, groupOf });
		expect(
			Object.keys(tools).filter((n) => groupOf(n) === "modest"),
		).not.toHaveLength(0);
	});

	// Within a round the cheapest schema goes first, so a budget that dies
	// mid-round leaves the most servers represented. Taking them in group
	// order instead would spend it all on the one expensive schema.
	it("admits the cheapest schema first within a round", () => {
		const input = {
			big_t0: tool({ type: "object", properties: {} }),
			small_t0: tool({ type: "object", properties: {} }),
			tiny_t0: tool({ type: "object", properties: {} }),
		};
		const precomputedBytes = { big_t0: 50, small_t0: 20, tiny_t0: 20 };
		const { tools } = capToolSet(input, {
			maxTools: 48,
			maxTotalSchemaBytes: 60,
			precomputedBytes,
			groupOf,
		});
		expect(Object.keys(tools).sort()).toEqual(["small_t0", "tiny_t0"]);
	});
});

describe("summarizeOmittedTools", () => {
	const serverOf = (name: string) => name.split("_")[0] as string;

	it("says nothing when the whole set survived", () => {
		expect(summarizeOmittedTools([], ["fizzy_a"], serverOf)).toEqual([]);
	});

	it("distinguishes a server that lost some tools from one that lost all", () => {
		const dropped = [
			{ name: "fizzy_b", reason: "over_tool_budget" },
			{ name: "ado_a", reason: "over_tool_budget" },
			{ name: "ado_b", reason: "over_tool_budget" },
		];
		expect(summarizeOmittedTools(dropped, ["fizzy_a"], serverOf)).toEqual([
			"fizzy (1 of its tools omitted)",
			"ado (all of its tools omitted)",
		]);
	});
});
