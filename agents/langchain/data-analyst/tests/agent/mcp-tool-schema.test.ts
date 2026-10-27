import { afterEach, describe, it, expect, vi } from "vitest";
import { ToolInputParsingException } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { __testing } from "@/lib/agent/graph";

const { createMcpTool, loadMcpTools, projectMcpInputSchema } = __testing;
type CallTool = Parameters<typeof createMcpTool>[1];

const definition = {
	name: "query",
	description: "Query data",
	inputSchema: {
		type: "object" as const,
		properties: { query: { type: "string" as const } },
		required: ["query"],
	},
};

function makeTool(inputSchema: unknown = definition.inputSchema) {
	const callTool = vi.fn<CallTool>().mockResolvedValue({
		content: [{ type: "text", text: "ok" }],
	});
	const tool = createMcpTool(
		{ ...definition, inputSchema },
		callTool,
		"Example Server",
	);
	return { tool, callTool };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function assertProjectedSchema(value: unknown, depth = 0) {
	expect(depth).toBeLessThanOrEqual(9);
	expect(value).not.toBeNull();
	expect(typeof value).toBe("object");
	expect(Array.isArray(value)).toBe(false);
	expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
	const schema = value as Record<string, unknown>;
	const types = [
		"string",
		"number",
		"integer",
		"boolean",
		"object",
		"array",
		"null",
	];
	const allowedKeys =
		depth === 0
			? [
					"type",
					"description",
					"properties",
					"required",
					"additionalProperties",
				]
			: [
					"type",
					"description",
					"enum",
					"anyOf",
					"items",
					"properties",
					"required",
					"additionalProperties",
				];
	for (const key of Object.keys(schema)) expect(allowedKeys).toContain(key);
	if (depth === 0) {
		expect(schema.type).toBe("object");
		expect(schema).toHaveProperty("properties");
	}
	if ("type" in schema) {
		if (Array.isArray(schema.type)) {
			expect(schema.type.length).toBeGreaterThan(0);
			expect(new Set(schema.type).size).toBe(schema.type.length);
			for (const type of schema.type) expect(types).toContain(type);
		} else expect(types).toContain(schema.type);
	}
	if ("description" in schema)
		expect(typeof schema.description).toBe("string");
	if ("enum" in schema) {
		expect(Array.isArray(schema.enum)).toBe(true);
		const values = schema.enum as unknown[];
		expect(values.length).toBeGreaterThan(0);
		for (const item of values) {
			expect(
				item === null ||
					["string", "number", "boolean"].includes(typeof item),
			).toBe(true);
		}
	}
	if ("anyOf" in schema) {
		expect(Array.isArray(schema.anyOf)).toBe(true);
		const branches = schema.anyOf as unknown[];
		expect(branches.length).toBeGreaterThan(0);
		for (const branch of branches) assertProjectedSchema(branch, depth + 1);
	}
	const keptTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
	if (keptTypes.includes("array")) expect(schema).toHaveProperty("items");
	if ("items" in schema) assertProjectedSchema(schema.items, depth + 1);
	if (keptTypes.includes("object"))
		expect(schema).toHaveProperty("properties");
	if ("properties" in schema) {
		expect(schema.properties).not.toBeNull();
		expect(typeof schema.properties).toBe("object");
		expect(Array.isArray(schema.properties)).toBe(false);
		for (const property of Object.values(
			schema.properties as Record<string, unknown>,
		)) {
			assertProjectedSchema(property, depth + 1);
		}
	}
	if ("required" in schema) {
		expect(Array.isArray(schema.required)).toBe(true);
		const required = schema.required as unknown[];
		expect(required.length).toBeGreaterThan(0);
		for (const key of required) {
			expect(typeof key).toBe("string");
			expect(Object.keys(schema.properties as object)).toContain(key);
		}
	}
	if (
		"additionalProperties" in schema &&
		typeof schema.additionalProperties !== "boolean"
	) {
		assertProjectedSchema(schema.additionalProperties, depth + 1);
	}
}

describe("MCP tool schema", () => {
	it.each([100_000, 100])(
		"falls back quickly for repeated large descriptions and enums (%i description chars)",
		(descriptionLength) => {
			let descriptionReads = 0;
			const shared = {
				type: "string",
				get description() {
					descriptionReads++;
					return "x".repeat(descriptionLength);
				},
				enum: Array.from(
					{ length: 5000 },
					(_, index) => `option${index}`,
				),
			};
			const warn = vi.fn();
			const started = performance.now();
			const projected = projectMcpInputSchema(
				{
					$defs: { shared },
					properties: Object.fromEntries(
						Array.from({ length: 990 }, (_, index) => [
							`field${index}`,
							{ $ref: "#/$defs/shared" },
						]),
					),
				},
				warn,
			);
			expect(performance.now() - started).toBeLessThan(1000);
			expect(descriptionReads).toBeLessThan(10);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn).toHaveBeenCalledWith(
				expect.stringMatching(/schema was too large.*\d+.*65536/),
			);
			expect(projected).toEqual({ type: "object", properties: {} });
		},
	);

	it.each([0, 1])(
		"enforces the final serialized size at the 65536-character boundary plus %i",
		(extra) => {
			const overhead = JSON.stringify({
				type: "object",
				properties: {},
				description: "",
			}).length;
			const schema = {
				type: "object",
				properties: {},
				description: "x".repeat(65536 - overhead + extra),
			};
			const warn = vi.fn();
			const projected = projectMcpInputSchema(schema, warn);
			if (extra === 0) {
				expect(projected).toEqual(schema);
				expect(warn).not.toHaveBeenCalled();
			} else {
				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("65537"),
				);
				expect(projected).toEqual({ type: "object", properties: {} });
			}
		},
	);

	it("uses serialized length to catch JSON escaping beyond the approximate size", () => {
		const schema = {
			type: "object",
			properties: {},
			description: "\n".repeat(40_000),
		};
		const warn = vi.fn();
		const projected = projectMcpInputSchema(schema, warn);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(String(JSON.stringify(schema).length)),
		);
		expect(projected).toEqual({ type: "object", properties: {} });
	});

	it("preserves a normal described schema", () => {
		const schema = {
			type: "object",
			description: "Query sales",
			properties: {
				query: {
					type: "string",
					description: "Search terms",
					enum: ["sales", "revenue"],
				},
			},
			required: ["query"],
		};
		const warn = vi.fn();
		expect(projectMcpInputSchema(schema, warn)).toEqual(schema);
		expect(warn).not.toHaveBeenCalled();
	});

	it.each([4096, 4097])(
		"caps advertised tool descriptions at 4096 characters for length %i",
		(length) => {
			const tool = createMcpTool(
				{ ...definition, description: "x".repeat(length) },
				vi.fn<CallTool>(),
				"Example",
			);
			expect(tool.description).toBe("x".repeat(4096));
			expect(convertToOpenAITool(tool).function.description).toBe(
				tool.description,
			);
		},
	);

	it("retains the fallback description and caps it for long server names", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const tool = createMcpTool(
			{ name: "query" },
			vi.fn<CallTool>(),
			"Example",
		);
		expect(tool.description).toBe("Tool from Example: query");
		const server = "x".repeat(5000);
		const long = createMcpTool(
			{ name: "query" },
			vi.fn<CallTool>(),
			server,
		);
		expect(long.description).toBe(
			`Tool from ${server}: query`.slice(0, 4096),
		);
	});

	it("keeps prefixed names and collision suffixes within 64 characters", () => {
		const usedNames = new Set<string>();
		const tool = createMcpTool(
			{ ...definition, name: `-${"q".repeat(80)}` },
			vi.fn<CallTool>(),
			"1Example",
			usedNames,
		);
		const second = createMcpTool(
			{ ...definition, name: `-${"q".repeat(80)}` },
			vi.fn<CallTool>(),
			"1Example",
			usedNames,
		);
		for (const name of [tool.name, second.name]) {
			expect(name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);
			expect(name).toHaveLength(64);
		}
		expect(tool.name).toBe(`_1example_-${"q".repeat(53)}`);
		expect(second.name).not.toBe(tool.name);
	});

	it.each([false, true])(
		"limits pagination to 100 pages (ends at limit: %s)",
		async (endsAtLimit) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			let page = 0;
			const client = {
				listTools: vi
					.fn<Parameters<typeof loadMcpTools>[0]["listTools"]>()
					.mockImplementation(async () => {
						page++;
						return {
							tools: [{ ...definition, name: `query${page}` }],
							nextCursor:
								page < (endsAtLimit ? 100 : 102)
									? `page${page}`
									: undefined,
						};
					}),
				callTool: vi.fn<CallTool>(),
			};
			const tools = await loadMcpTools(client, "Example Server");
			expect(client.listTools).toHaveBeenCalledTimes(100);
			expect(tools).toHaveLength(100);
			expect(tools[99].name).toBe("example_server_query100");
			if (endsAtLimit) expect(warn).not.toHaveBeenCalled();
			else {
				expect(warn).toHaveBeenCalledOnce();
				expect(warn).toHaveBeenCalledWith(
					expect.stringMatching(/Example Server.*100/),
				);
			}
		},
	);

	it("falls back early when ref expansion exceeds the shared node budget", () => {
		let descriptionReads = 0;
		const $defs = Object.fromEntries(
			Array.from({ length: 5 }, (_, level) => {
				const node = {
					type: "object",
					properties: Object.fromEntries(
						Array.from({ length: 40 }, (_, index) => [
							`field${index}`,
							level === 4
								? { type: "string" }
								: { $ref: `#/$defs/level${level + 1}` },
						]),
					),
				};
				Object.defineProperty(node, "description", {
					enumerable: true,
					get: () => {
						descriptionReads++;
						return "Model fields";
					},
				});
				return [`level${level}`, node];
			}),
		);
		const warn = vi.fn();
		const start = performance.now();
		const projected = projectMcpInputSchema(
			{ $defs, properties: { model: { $ref: "#/$defs/level0" } } },
			warn,
		);
		expect(performance.now() - start).toBeLessThan(1000);
		expect(descriptionReads).toBeLessThan(6000);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("too large"));
		expect(projected).toEqual({ type: "object", properties: {} });
	});

	it.each([
		{
			server: "Example Server",
			name: "query.rows",
			expected: "example_server_query_rows",
		},
		{
			server: "Example (Reporting)",
			name: "query",
			expected: "example__reporting__query",
		},
		{
			server: "Example",
			name: "q".repeat(80),
			expected: `example_${"q".repeat(56)}`,
		},
		{ server: "1Example", name: "-query", expected: "_1example_-query" },
		{ server: "-Example", name: "-query", expected: "_-example_-query" },
	])(
		"advertises a valid provider name for $server/$name and calls the real MCP name",
		async ({ server, name, expected }) => {
			const callTool = vi
				.fn<CallTool>()
				.mockResolvedValue({ content: [] });
			const tool = createMcpTool(
				{ ...definition, name },
				callTool,
				server,
			);
			expect(convertToOpenAITool(tool).function.name).toBe(expected);
			expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
			await tool.invoke({ query: "sales" });
			expect(callTool).toHaveBeenCalledWith({
				name,
				arguments: { query: "sales" },
			});
		},
	);

	it("shares names across servers whose sanitized names collide", async () => {
		const usedNames = new Set<string>();
		const callTool = vi.fn<CallTool>().mockResolvedValue({ content: [] });
		const client = {
			listTools: vi
				.fn<Parameters<typeof loadMcpTools>[0]["listTools"]>()
				.mockResolvedValue({ tools: [definition] }),
			callTool,
		};
		const [first] = await loadMcpTools(client, "Example.Server", usedNames);
		const [second] = await loadMcpTools(
			client,
			"Example_Server",
			usedNames,
		);
		expect(first.name).toBe("example_server_query");
		expect(second.name).not.toBe(first.name);
		expect(second.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		await first.invoke({ query: "first" });
		await second.invoke({ query: "second" });
		expect(callTool.mock.calls).toEqual([
			[{ name: "query", arguments: { query: "first" } }],
			[{ name: "query", arguments: { query: "second" } }],
		]);
	});

	it("keeps collision suffixes within 64 characters and avoids occupied suffixes", () => {
		const base = `example_${"q".repeat(56)}`;
		const usedNames = new Set([base, `${base.slice(0, 62)}_1`]);
		const tool = createMcpTool(
			{ ...definition, name: "q".repeat(80) },
			vi.fn<CallTool>(),
			"Example",
			usedNames,
		);
		expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		expect(tool.name).not.toBe(base);
		expect(tool.name).not.toBe(`${base.slice(0, 62)}_1`);
		expect(usedNames.has(tool.name)).toBe(true);
	});

	it("reserves chart and analytics names before discovery from multiple servers", async () => {
		const builtins = [
			"create_chart",
			"list_data_sources",
			"suggest_connection",
			"calculate_statistics",
			"aggregate_data",
			"detect_trends",
			"join_datasets",
		];
		const servers = [
			...builtins.map((name) => ({
				serverName: name.slice(0, name.indexOf("_")),
				toolName: name.slice(name.indexOf("_") + 1),
			})),
			{ serverName: "Example.Server", toolName: "query" },
			{ serverName: "Example_Server", toolName: "query" },
		];
		const proxyServers = servers.map(({ serverName, toolName }, index) => ({
			configId: `example-config-${index}`,
			name: serverName,
			serverName,
			tools: [{ ...definition, name: toolName }],
		}));
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ servers: proxyServers })),
				),
		);
		const { mcpTools } = await __testing.discoverMcpTools(
			{
				messages: [],
				systemPrompt: "",
				response: "",
				error: null,
				mcpTools: [],
				chartArtifacts: [],
				connectionSuggestions: [],
				availableDataSources: [],
				reasoningByTurn: {},
			},
			{ configurable: { ai_token: "synthetic-token" } },
		);
		const toolNames = (mcpTools ?? []).map(
			(tool) => convertToOpenAITool(tool).function.name,
		);
		expect(toolNames).toHaveLength(builtins.length + servers.length);
		expect(new Set(toolNames).size).toBe(toolNames.length);
		for (const name of toolNames)
			expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		for (const name of builtins)
			expect(
				toolNames.filter((toolName) => toolName === name),
			).toHaveLength(1);
	});

	it.each([1999, 2000])(
		"counts empty property schemas against the node budget: %i properties",
		(count) => {
			const warn = vi.fn();
			const projected = projectMcpInputSchema(
				{
					properties: Object.fromEntries(
						Array.from({ length: count }, (_, index) => [
							`field${index}`,
							null,
						]),
					),
				},
				warn,
			);
			if (count === 1999) {
				expect(
					Object.keys(projected.properties as object),
				).toHaveLength(count);
				expect(warn).not.toHaveBeenCalled();
			} else {
				expect(projected).toEqual({ type: "object", properties: {} });
				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("too large"),
				);
			}
		},
	);

	it.each(["label", 42, false, null])(
		"projects primitive const %j to enum in discriminated anyOf branches",
		(constant) => {
			const projected = projectMcpInputSchema({
				properties: {
					selection: {
						anyOf: [
							{
								type: "object",
								properties: { kind: { const: constant } },
								required: ["kind"],
							},
							{
								type: "object",
								properties: { kind: { const: "other" } },
								required: ["kind"],
							},
						],
					},
					explicit: { enum: ["explicit"], const: constant },
					invalidEnum: { enum: false, const: constant },
					invalidConst: { const: {} },
				},
			});
			expect(projected).toEqual({
				type: "object",
				properties: {
					selection: {
						anyOf: [
							{
								type: "object",
								properties: { kind: { enum: [constant] } },
								required: ["kind"],
							},
							{
								type: "object",
								properties: { kind: { enum: ["other"] } },
								required: ["kind"],
							},
						],
					},
					explicit: { enum: ["explicit"] },
					invalidEnum: {},
					invalidConst: {},
				},
			});
			assertProjectedSchema(projected);
		},
	);

	it("inlines a single nested allOf ref and overrides its description", () => {
		const projected = projectMcpInputSchema({
			$defs: {
				model: {
					type: "object",
					description: "Definition",
					properties: { label: { type: "string" } },
				},
			},
			properties: {
				model: {
					allOf: [{ $ref: "#/$defs/model" }],
					description: "Selected model",
				},
				multiple: {
					allOf: [{ type: "string" }, { type: "number" }],
					description: "Dropped",
				},
				invalid: { allOf: [null] },
			},
		});
		expect(projected).toEqual({
			type: "object",
			properties: {
				model: {
					type: "object",
					description: "Selected model",
					properties: { label: { type: "string" } },
				},
				multiple: { description: "Dropped" },
				invalid: {},
			},
		});
		assertProjectedSchema(projected);
	});

	it.each(["", "next"])(
		"stops pagination when cursor %j repeats and names the server in its warning",
		async (cursor) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const client = {
				listTools: vi
					.fn<Parameters<typeof loadMcpTools>[0]["listTools"]>()
					.mockResolvedValue({ tools: [] })
					.mockResolvedValueOnce({
						tools: [definition],
						nextCursor: cursor,
					})
					.mockResolvedValueOnce({
						tools: [{ ...definition, name: "second" }],
						nextCursor: cursor,
					}),
				callTool: vi.fn<CallTool>(),
			};
			const tools = await loadMcpTools(client, "Example Server");
			expect(tools.map((tool) => tool.name)).toEqual([
				"example_server_query",
				"example_server_second",
			]);
			expect(client.listTools.mock.calls).toEqual([
				[],
				[{ params: { cursor } }],
			]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("Example Server"),
			);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("cursor"),
			);
		},
	);

	it("stops a pagination cursor cycle across different pages", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const client = {
			listTools: vi
				.fn<Parameters<typeof loadMcpTools>[0]["listTools"]>()
				.mockResolvedValue({ tools: [] })
				.mockResolvedValueOnce({
					tools: [definition],
					nextCursor: "first",
				})
				.mockResolvedValueOnce({ tools: [], nextCursor: "second" })
				.mockResolvedValueOnce({ tools: [], nextCursor: "first" }),
			callTool: vi.fn<CallTool>(),
		};
		expect(await loadMcpTools(client, "Example Server")).toHaveLength(1);
		expect(client.listTools.mock.calls).toEqual([
			[],
			[{ params: { cursor: "first" } }],
			[{ params: { cursor: "second" } }],
		]);
		expect(warn).toHaveBeenCalledOnce();
	});

	it("advertises declared properties and required to the model", () => {
		const { tool } = makeTool();
		expect(convertToOpenAITool(tool).function.parameters).toEqual({
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		});
		expect(tool.name).toBe("example_server_query");
		expect(tool.description).toBe("Query data");
	});

	it("advertises additionalProperties true and passes extra arguments through", async () => {
		const { tool, callTool } = makeTool({
			...definition.inputSchema,
			additionalProperties: true,
		});
		expect(convertToOpenAITool(tool).function.parameters).toHaveProperty(
			"additionalProperties",
			true,
		);
		await expect(tool.invoke({ query: "sales", limit: 5 })).resolves.toBe(
			"ok",
		);
		expect(callTool).toHaveBeenCalledWith({
			name: "query",
			arguments: { query: "sales", limit: 5 },
		});
	});

	it("advertises additionalProperties false and rejects extras before execution", async () => {
		const { tool, callTool } = makeTool({
			...definition.inputSchema,
			additionalProperties: false,
		});
		expect(convertToOpenAITool(tool).function.parameters).toHaveProperty(
			"additionalProperties",
			false,
		);
		await expect(
			tool.invoke({ query: "sales", limit: 5 }),
		).rejects.toBeInstanceOf(ToolInputParsingException);
		expect(callTool).not.toHaveBeenCalled();
	});

	it("keeps extra arguments when additionalProperties is omitted", async () => {
		const { tool, callTool } = makeTool();
		expect(
			convertToOpenAITool(tool).function.parameters,
		).not.toHaveProperty("additionalProperties");
		await tool.invoke({ query: "sales", limit: 5 });
		expect(callTool).toHaveBeenCalledWith({
			name: "query",
			arguments: { query: "sales", limit: 5 },
		});
	});

	it.each([{}, { inputSchema: {} }, { inputSchema: { type: "object" } }])(
		"defaults a definition with absent inputSchema or properties: %j",
		async (fields) => {
			const callTool = vi
				.fn<CallTool>()
				.mockResolvedValue({ content: [] });
			const tool = createMcpTool(
				{ name: "empty", ...fields },
				callTool,
				"Example",
			);
			expect(convertToOpenAITool(tool).function.parameters).toEqual({
				type: "object",
				properties: {},
			});
			await tool.invoke({});
			expect(callTool).toHaveBeenCalledWith({
				name: "empty",
				arguments: {},
			});
			expect(tool.description).toBe("Tool from Example: empty");
		},
	);

	it("rejects a type mismatch with a message naming the field", async () => {
		const { tool, callTool } = makeTool();
		await expect(tool.invoke({ query: 42 })).rejects.toThrow(/query/);
		expect(callTool).not.toHaveBeenCalled();
	});

	it("inlines local $defs refs and leaves dropped constraints to the server", async () => {
		const inputSchema = {
			type: "object",
			$defs: {
				model: {
					type: "object",
					description: "Model fields",
					properties: { count: { type: "integer", minimum: 1 } },
					required: ["count"],
				},
			},
			properties: {
				model: { $ref: "#/$defs/model", description: "Selected model" },
			},
			required: ["model"],
			additionalProperties: { type: "string" },
		};
		const { tool, callTool } = makeTool(inputSchema);
		expect(convertToOpenAITool(tool).function.parameters).toEqual({
			type: "object",
			properties: {
				model: {
					type: "object",
					description: "Selected model",
					properties: { count: { type: "integer" } },
					required: ["count"],
				},
			},
			required: ["model"],
			additionalProperties: { type: "string" },
		});
		expect(tool.schema).not.toBe(inputSchema);
		await expect(
			tool.invoke({ model: { count: "two" } }),
		).rejects.toThrow();
		expect(callTool).not.toHaveBeenCalled();
		await tool.invoke({ model: { count: 0 }, label: "sales" });
		expect(callTool).toHaveBeenCalledWith({
			name: "query",
			arguments: { model: { count: 0 }, label: "sales" },
		});
	});

	it("gives array properties without items an empty items schema", () => {
		const { tool } = makeTool({
			type: "object",
			properties: { rows: { type: "array" } },
		});
		expect(convertToOpenAITool(tool).function.parameters).toEqual({
			type: "object",
			properties: { rows: { type: "array", items: {} } },
		});
	});

	it("preserves Optional-style anyOf and converts nested oneOf to anyOf", () => {
		const optional = { anyOf: [{ type: "string" }, { type: "null" }] };
		const { tool } = makeTool({
			properties: { label: optional, other: { oneOf: optional.anyOf } },
		});
		expect(convertToOpenAITool(tool).function.parameters).toEqual({
			type: "object",
			properties: { label: optional, other: optional },
		});
	});

	it("limits adversarial tool schemas to the recursive allowlist grammar", () => {
		let deep: unknown = { type: "string", pattern: ".*" };
		for (let i = 0; i < 100; i++) {
			deep = {
				type: "object",
				description: "Nested",
				properties: { child: deep },
			};
		}
		const inputs = [
			{
				properties: {
					rows: { type: "array" },
					nested: { properties: { rows: { type: "array" } } },
				},
			},
			{
				properties: {
					q: "string",
					empty: null,
					flag: false,
					tuple: [],
					date: new Date(),
				},
			},
			{ properties: { q: { type: "string" } }, required: true },
			{
				properties: { q: { type: "string" } },
				required: ["missing", "q", 42],
			},
			{ enum: ["blocked"] },
			{ not: { type: "object" } },
			{ $ref: "#/$defs/missing" },
			{
				properties: {
					q: {
						allOf: [{ type: "string" }],
						not: {},
						if: {},
						then: {},
						else: {},
						format: "email",
						minimum: 1,
						pattern: ".*",
						default: "example",
					},
				},
			},
			{
				properties: {
					rows: { type: "array", items: [{ type: "string" }] },
				},
			},
			{
				properties: {
					q: { type: "invalid" },
					n: { type: 42 },
					empty: { type: [] },
					mixed: { type: ["string", "bad"] },
					repeat: { type: ["array", "array", "null"] },
				},
			},
			{
				properties: {
					q: { enum: [{ invalid: true }] },
					n: { enum: [] },
					label: { description: 42 },
					rows: { anyOf: [true] },
					other: { oneOf: [] },
					extra: { type: "object", additionalProperties: [] },
				},
			},
			{
				$defs: {
					node: {
						type: "object",
						properties: { child: { $ref: "#/$defs/node" } },
					},
				},
				properties: { node: { $ref: "#/$defs/node" } },
			},
			{ properties: { deep } },
			{ properties: [] },
			{ properties: null },
			{ properties: "invalid" },
		];
		vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const input of inputs) {
			const { tool } = makeTool(input);
			assertProjectedSchema(
				convertToOpenAITool(tool).function.parameters,
			);
		}
	});

	it("keeps valid guidance while dropping malformed values and unknown keywords", () => {
		expect(
			projectMcpInputSchema({
				description: "Query options",
				properties: {
					choice: {
						type: ["string", "null", "string"],
						enum: ["a", 1, false, null],
						format: "email",
					},
					rows: {
						type: ["array", "null"],
						items: { type: "number", minimum: 0 },
					},
					object: {
						type: "object",
						required: ["missing"],
						additionalProperties: {
							type: "boolean",
							default: true,
						},
					},
					q: "string",
					invalid: {
						type: ["string", "bad"],
						enum: [{}],
						description: false,
						anyOf: [null],
						additionalProperties: true,
					},
				},
				required: ["choice", 42, "missing", "q"],
				additionalProperties: false,
				default: {},
			}),
		).toEqual({
			type: "object",
			description: "Query options",
			properties: {
				choice: {
					type: ["string", "null"],
					enum: ["a", 1, false, null],
				},
				rows: { type: ["array", "null"], items: { type: "number" } },
				object: {
					type: "object",
					properties: {},
					additionalProperties: { type: "boolean" },
				},
				q: {},
				invalid: {},
			},
			required: ["choice", "q"],
			additionalProperties: false,
		});
	});

	it("resolves root and nested legacy definitions refs with description precedence", () => {
		expect(
			projectMcpInputSchema({
				$ref: "#/definitions/input",
				description: "Tool input",
				definitions: {
					input: {
						type: "object",
						description: "Definition",
						properties: { label: { $ref: "#/definitions/label" } },
					},
					label: {
						type: "string",
						description: "Label",
						enum: ["sales"],
					},
				},
			}),
		).toEqual({
			type: "object",
			description: "Tool input",
			properties: {
				label: {
					type: "string",
					description: "Label",
					enum: ["sales"],
				},
			},
		});
	});

	it("drops unresolved nested refs and bounds recursive refs with descriptions", () => {
		const projected = projectMcpInputSchema({
			$defs: {
				loop: { $ref: "#/$defs/loop", description: "Recursive" },
				invalid: false,
			},
			properties: {
				loop: { $ref: "#/$defs/loop", description: "Outer" },
				missing: {
					$ref: "#/$defs/missing",
					type: "string",
					description: "Missing",
				},
				external: {
					$ref: "https://example.com/schema",
					description: "External",
				},
				invalid: { $ref: "#/$defs/invalid" },
			},
		});
		expect(projected).toEqual({
			type: "object",
			properties: {
				loop: { description: "Outer" },
				missing: { description: "Missing" },
				external: { description: "External" },
				invalid: {},
			},
		});
	});

	it("retains guidance through depth 8 and only description past the cap", () => {
		let deep: unknown = { type: "string", description: "Leaf" };
		for (let i = 0; i < 10; i++) {
			deep = {
				type: "object",
				description: "Nested",
				properties: { child: deep },
			};
		}
		const projected = projectMcpInputSchema({
			properties: { child: deep },
		});
		let node = projected;
		for (let depth = 1; depth <= 8; depth++) {
			node = (node.properties as Record<string, Record<string, unknown>>)
				.child;
			expect(node.type).toBe("object");
			expect(node.description).toBe("Nested");
		}
		expect(node.properties).toEqual({ child: { description: "Nested" } });
	});

	it("drops sparse type, enum and alternative arrays rather than emitting holes", () => {
		const projected = projectMcpInputSchema({
			properties: {
				type: { type: new Array<unknown>(1) },
				enum: { enum: new Array<unknown>(1) },
				alternative: { anyOf: new Array<unknown>(1) },
			},
		});
		expect(projected).toEqual({
			type: "object",
			properties: { type: {}, enum: {}, alternative: {} },
		});
	});

	it.each([undefined, null, false, "object", [], new Date()])(
		"defaults a missing or non-plain schema: %j",
		(schema) => {
			expect(projectMcpInputSchema(schema)).toEqual({
				type: "object",
				properties: {},
			});
		},
	);

	it("preserves supported keyword values and drops unused definitions", () => {
		const schema = {
			type: "object",
			properties: {},
			$defs: { label: { type: "string" } },
			additionalProperties: false,
		};
		expect(projectMcpInputSchema(schema)).toEqual({
			type: "object",
			properties: {},
			additionalProperties: false,
		});
		expect(
			projectMcpInputSchema({
				properties: { query: { type: "string" } },
			}),
		).toEqual({
			type: "object",
			properties: { query: { type: "string" } },
		});
		expect(projectMcpInputSchema(Object.create(null))).toEqual({
			type: "object",
			properties: {},
		});
	});

	it.each([
		{ schema: { type: "array" }, reason: "root type" },
		{ schema: { type: null }, reason: "root type" },
		{ schema: { type: ["object", "null"] }, reason: "root type" },
		{ schema: { anyOf: [{ type: "object" }] }, reason: "anyOf" },
		{ schema: { oneOf: [{ type: "object" }] }, reason: "oneOf" },
		{ schema: { allOf: [{ type: "object" }] }, reason: "allOf" },
		{ schema: { enum: ["value"] }, reason: "enum" },
		{ schema: { not: { type: "string" } }, reason: "not" },
		{ schema: { $ref: "#/$defs/missing" }, reason: "$ref" },
		{
			schema: {
				$ref: "#/$defs/loop",
				$defs: { loop: { $ref: "#/$defs/loop" } },
			},
			reason: "$ref",
		},
		{
			schema: {
				$ref: "#/definitions/input",
				definitions: { input: { type: "array" } },
			},
			reason: "root type",
		},
		{ schema: null, reason: "plain object" },
	])(
		"falls back for unsupported root schema $schema and forwards arguments",
		async ({ schema, reason }) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { tool, callTool } = makeTool(
				schema === null
					? null
					: {
							...schema,
							required: ["discarded"],
							additionalProperties: false,
						},
			);
			expect(convertToOpenAITool(tool).function.parameters).toEqual({
				type: "object",
				properties: {},
			});
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("Example Server/query"),
			);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason));
			await expect(
				tool.invoke({ query: "sales", extra: 5 }),
			).resolves.toBe("ok");
			expect(callTool).toHaveBeenCalledWith({
				name: "query",
				arguments: { query: "sales", extra: 5 },
			});
		},
	);

	it("loads both pages and invokes tools through the client with its receiver", async () => {
		const client = {
			listTools: vi
				.fn<Parameters<typeof loadMcpTools>[0]["listTools"]>()
				.mockResolvedValueOnce({ tools: [definition], nextCursor: "" })
				.mockResolvedValueOnce({
					tools: [{ ...definition, name: "second" }],
				}),
			callTool: vi.fn<CallTool>().mockImplementation(async function (
				this: unknown,
			) {
				expect(this).toBe(client);
				return { content: [{ type: "text", text: "page two" }] };
			}),
		};
		const tools = await loadMcpTools(client, "Example Server");
		expect(tools.map((tool) => tool.name)).toEqual([
			"example_server_query",
			"example_server_second",
		]);
		expect(client.listTools.mock.calls).toEqual([
			[],
			[{ params: { cursor: "" } }],
		]);
		await expect(tools[1].invoke({ query: "sales" })).resolves.toBe(
			"page two",
		);
		expect(client.callTool).toHaveBeenCalledWith({
			name: "second",
			arguments: { query: "sales" },
		});
	});

	it("flattens isError results as content", async () => {
		const { tool, callTool } = makeTool();
		callTool.mockResolvedValue({
			isError: true,
			content: [
				{ type: "text", text: "query failed" },
				{ type: "image", data: "synthetic", mimeType: "image/png" },
			],
		});
		await expect(tool.invoke({ query: "sales" })).resolves.toBe(
			"query failed\n![Image](synthetic)",
		);
	});

	it("retains execution error logging and text fallback", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { tool, callTool } = makeTool();
		callTool.mockRejectedValue(new Error("synthetic failure"));
		await expect(tool.invoke({ query: "sales" })).resolves.toBe(
			"Error executing query: synthetic failure",
		);
		expect(error).toHaveBeenCalledWith(
			"[DataAnalyst] Tool query failed:",
			"synthetic failure",
		);
	});
});
