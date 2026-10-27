import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { __testing } from "@/lib/agent/graph";

const definition = {
	name: "query",
	description: "Query data",
	inputSchema: {
		type: "object",
		properties: { query: { type: "string" } },
		required: ["query"],
	},
	annotations: { readOnlyHint: true },
};
const servers = [
	{
		configId: "config-1",
		name: "Example",
		serverName: "Example Server",
		tools: [definition],
	},
];
const builtinNames = [
	"create_chart",
	"list_data_sources",
	"suggest_connection",
	"calculate_statistics",
	"aggregate_data",
	"detect_trends",
	"join_datasets",
];
const fetchMock = vi.fn<typeof fetch>();
function discover(token: string | undefined = "synthetic-token") {
	return __testing.discoverMcpTools({} as never, {
		configurable: { ai_token: token },
	});
}
beforeEach(() => {
	vi.stubEnv("RUNTIME_API_URL", "https://example.com");
	vi.stubGlobal("fetch", fetchMock);
	fetchMock
		.mockReset()
		.mockResolvedValue(new Response(JSON.stringify({ servers })));
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Fabric MCP proxy discovery", () => {
	it("posts list with the AI token and preserves MCP naming and schema", async () => {
		const state = await discover();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.com/api/internal/mcp-tools",
			{
				method: "POST",
				headers: {
					"X-AI-Token": "synthetic-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ operation: "list" }),
			},
		);
		const tool = state.mcpTools?.find(
			(tool) => tool.name === "example_server_query",
		);
		expect(tool).toBeDefined();
		expect(convertToOpenAITool(tool).function.parameters).toMatchObject(
			definition.inputSchema,
		);
		expect(state.availableDataSources).toEqual(["Example Server"]);
		const sources = state.mcpTools?.find(
			(tool) => tool.name === "list_data_sources",
		);
		expect(await sources.invoke({})).toContain("Example");
	});
	it.each([undefined, null, {}])(
		"accepts a missing or non-array unavailable field: %j",
		async (unavailable) => {
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify({ servers, unavailable })),
			);
			const state = await discover();
			const tool = state.mcpTools?.find(
				(tool) => tool.name === "list_data_sources",
			);
			const output = JSON.parse(await tool.invoke({}));
			expect(output.connected).toBe(true);
			expect(output.unavailable).toEqual([]);
		},
	);
	it.each([true, false])(
		"reports unavailable sources separately with connected sources: %s",
		async (connected) => {
			const unavailable = [
				{ name: "Example Auth", code: "OAUTH_AUTH_REQUIRED" },
				{ name: "Example Offline", code: "CONNECTION_ERROR" },
			];
			fetchMock.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ servers: connected ? servers : [], unavailable }),
				),
			);
			const state = await discover();
			const tool = state.mcpTools?.find(
				(tool) => tool.name === "list_data_sources",
			);
			const output = JSON.parse(await tool.invoke({}));
			expect(output.connected).toBe(connected);
			expect(output.unavailable).toEqual([
				expect.objectContaining({
					name: "Example Auth",
					code: "OAUTH_AUTH_REQUIRED",
					message: expect.stringContaining("needs reconnecting"),
				}),
				expect.objectContaining({
					name: "Example Offline",
					code: "CONNECTION_ERROR",
					message: expect.stringContaining("temporarily unavailable"),
				}),
			]);
			expect(output.message).toContain("Settings > MCP Servers");
			expect(output.message).toContain("Example Auth");
			expect(output.message).toContain("Example Offline");
			expect(output.message).not.toContain("No data sources connected");
			if (!connected)
				expect(output.message).toContain("No data sources are working");
			expect(state.availableDataSources).toEqual(
				connected ? ["Example Server"] : [],
			);
		},
	);
	it.each([
		"OAUTH_AUTH_REQUIRED",
		"CONFIG_DISABLED",
		"AUTH_FAILED",
		"API_KEY_MISSING",
		"OAUTH_ERROR",
		"INVALID_TWILIO_CREDENTIALS",
	])("explains reconnect code %s", async (code) => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					servers: [],
					unavailable: [{ name: "Example Auth", code }],
				}),
			),
		);
		const state = await discover();
		const tool = state.mcpTools?.find(
			(tool) => tool.name === "list_data_sources",
		);
		expect(await tool.invoke({})).toContain("needs reconnecting");
	});
	it("suggests reconnecting a configured unavailable integration", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					servers: [],
					unavailable: [{ name: "Example Query", code: "AUTH_FAILED" }],
				}),
			),
		);
		const state = await discover();
		const tool = state.mcpTools?.find(
			(tool) => tool.name === "suggest_connection",
		);
		const output = JSON.parse(
			await tool.invoke({
				integration: "Example Query",
				reason: "analyze data",
			}),
		);
		expect(output.message).toContain("configured but needs reconnecting");
		expect(output.message).toContain("Settings > MCP Servers");
		expect(output.message).not.toContain("already connected");
	});

	it("posts call with config id, original tool name and arguments", async () => {
		const state = await discover();
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					result: { content: [{ type: "text", text: "one row" }] },
				}),
			),
		);
		const tool = state.mcpTools?.find(
			(tool) => tool.name === "example_server_query",
		);
		expect(await tool.invoke({ query: "select 1" })).toBe("one row");
		expect(fetchMock).toHaveBeenLastCalledWith(
			"https://example.com/api/internal/mcp-tools",
			{
				method: "POST",
				headers: {
					"X-AI-Token": "synthetic-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					operation: "call",
					configId: "config-1",
					toolName: "query",
					arguments: { query: "select 1" },
				}),
			},
		);
	});
	it("returns a model-visible tool error with status and no response body", async () => {
		const state = await discover();
		fetchMock.mockResolvedValueOnce(
			new Response("private diagnostics".repeat(1000), { status: 403 }),
		);
		const tool = state.mcpTools?.find(
			(tool) => tool.name === "example_server_query",
		);
		const result = await tool.invoke({ query: "select 1" });
		expect(result).toContain("Error executing query");
		expect(result).toContain("403");
		expect(result).not.toContain("private diagnostics");
	});
	it("keeps only built-ins when listing fails without exposing the response body", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		fetchMock.mockResolvedValueOnce(
			new Response("private diagnostics", { status: 404 }),
		);
		const state = await discover();
		expect(state.mcpTools?.map((tool) => tool.name)).toEqual(builtinNames);
		expect(state.availableDataSources).toEqual([]);
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
			"private diagnostics",
		);
	});
	it("makes no request without a token", async () => {
		const state = await discover("");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(state.mcpTools?.map((tool) => tool.name)).toEqual(["create_chart"]);
	});
	it.each([409, 422, 429])(
		"passes a bounded actionable message to the model for HTTP %i",
		async (status) => {
			const state = await discover();
			const message = "Invalid query parameter. ".repeat(40);
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "Tool call failed", message }), {
					status,
				}),
			);
			const tool = state.mcpTools?.find(
				(tool) => tool.name === "example_server_query",
			);
			expect(await tool.invoke({ query: "select 1" })).toBe(
				`Error executing query: Failed to call MCP tool query: HTTP ${status}: ${message.slice(0, 500)}`,
			);
		},
	);
	it("uses the actionable error fallback when no message is present", async () => {
		const state = await discover();
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ error: "Reconnect the server in Fabric" }),
				{ status: 409 },
			),
		);
		const tool = state.mcpTools?.find(
			(tool) => tool.name === "example_server_query",
		);
		expect(await tool.invoke({ query: "select 1" })).toContain(
			"Reconnect the server in Fabric",
		);
	});
	it("keeps HTTP 500 generic even if a body includes a message", async () => {
		const state = await discover();
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ message: "Bearer secret-value" }), {
				status: 500,
			}),
		);
		const tool = state.mcpTools?.find(
			(tool) => tool.name === "example_server_query",
		);
		expect(await tool.invoke({ query: "select 1" })).toBe(
			"Error executing query: Failed to call MCP tool query: HTTP 500",
		);
	});
});

describe("MCP unavailable guidance and matching", () => {
	it.each([
		["AUTH_FAILED", "needs reconnecting in Settings > MCP Servers"],
		["MCP_PERMISSION_DENIED", "ask an organization admin"],
		["ORGANIZATION_MEMBERSHIP_REQUIRED", "ask an organization admin"],
		["RATE_LIMIT", "rate limited; try again later"],
		["NO_SERVER_URL", "misconfigured; check its settings"],
		["BLOCKED_URL", "temporarily unavailable; try again later"],
		["STDIO_WRAPPER_NOT_CONFIGURED", "temporarily unavailable; try again later"],
		["CONNECTION_ERROR", "temporarily unavailable; try again later"],
	])("uses the instruction for %s in both tools", async (code, instruction) => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					servers: [],
					unavailable: [{ name: "Example Query", code }],
				}),
			),
		);
		const state = await discover();
		for (const name of ["list_data_sources", "suggest_connection"]) {
			const tool = state.mcpTools?.find((tool) => tool.name === name);
			const output = JSON.parse(
				await tool.invoke(
					name === "list_data_sources"
						? {}
						: { integration: "example query", reason: "analyze data" },
				),
			);
			expect(output.message).toContain(instruction);
			if (code !== "AUTH_FAILED")
				expect(output.message).not.toContain("reconnect");
		}
	});
	it.each([
		["GitHub", "GitHub"],
		["Google Sheets", "Google Drive"],
	])("prefers connected %s over unavailable %s", async (healthy, broken) => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					servers: [{ ...servers[0], name: healthy, serverName: healthy }],
					unavailable: [{ name: broken, code: "AUTH_FAILED" }],
				}),
			),
		);
		const state = await discover();
		const tool = state.mcpTools?.find(
			(tool) => tool.name === "suggest_connection",
		);
		expect(
			JSON.parse(
				await tool.invoke({ integration: healthy, reason: "analyze data" }),
			).message,
		).toContain("already connected");
	});
	it.each(["Example server", "Google Sheets"])(
		"does not loosely match unavailable names for %s",
		async (integration) => {
			fetchMock.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						servers: [],
						unavailable: [
							{ name: "MCP Server", code: "AUTH_FAILED" },
							{ name: "Google Drive", code: "AUTH_FAILED" },
						],
					}),
				),
			);
			const state = await discover();
			const tool = state.mcpTools?.find(
				(tool) => tool.name === "suggest_connection",
			);
			expect(
				JSON.parse(await tool.invoke({ integration, reason: "analyze data" }))
					.message,
			).toContain("I've suggested connecting");
		},
	);
	it("matches the complete unavailable name within a request", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					servers: [],
					unavailable: [{ name: "Example Query", code: "AUTH_FAILED" }],
				}),
			),
		);
		const state = await discover();
		const tool = state.mcpTools?.find(
			(tool) => tool.name === "suggest_connection",
		);
		expect(
			JSON.parse(
				await tool.invoke({
					integration: "Connect EXAMPLE QUERY please",
					reason: "analyze data",
				}),
			).message,
		).toContain("needs reconnecting in Settings > MCP Servers");
	});
	it("drops invalid unavailable entries while keeping valid names and codes", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					servers: [],
					unavailable: [
						null,
						"invalid",
						{},
						{ name: 1, code: "AUTH_FAILED" },
						{ name: "Example", code: 1 },
						{ name: "Example Query", code: "AUTH_FAILED" },
					],
				}),
			),
		);
		const state = await discover();
		const tool = state.mcpTools?.find(
			(tool) => tool.name === "list_data_sources",
		);
		const output = JSON.parse(await tool.invoke({}));
		expect(output.unavailable).toEqual([
			expect.objectContaining({ name: "Example Query", code: "AUTH_FAILED" }),
		]);
	});
});
