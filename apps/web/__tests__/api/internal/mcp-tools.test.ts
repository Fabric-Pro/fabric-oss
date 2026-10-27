import { MCPClientError, McpClientError } from "@repo/mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verify: vi.fn(),
	configs: vi.fn(),
	reauthConfigs: vi.fn(),
	connect: vi.fn(),
	close: vi.fn(),
}));
vi.mock("@repo/database", () => ({}));
vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: mocks.verify,
}));
vi.mock("@repo/agent-core/backend", () => ({
	getEnabledMcpConfigs: mocks.configs,
	getMcpConfigsNeedingReauth: mocks.reauthConfigs,
	getMcpClient: mocks.connect,
	getMcpClientResult: mocks.connect,
	closeMcpClientSafe: mocks.close,
}));

import { POST } from "../../../app/api/internal/mcp-tools/route";

const readTool = {
	name: "query",
	inputSchema: { type: "object", properties: {} },
	annotations: { readOnlyHint: true },
};
const result = {
	content: [{ type: "text", text: "ok" }],
	isError: false,
	structuredContent: { rows: [1] },
};
const callBody = {
	operation: "call",
	configId: "config-1",
	toolName: "query",
	arguments: { query: "select 1" },
};
let client: {
	listTools: ReturnType<typeof vi.fn>;
	callTool: ReturnType<typeof vi.fn>;
};
function request(
	body: unknown = { operation: "list" },
	token: string | null = "synthetic-token",
) {
	return POST(
		new Request("https://example.com/api/internal/mcp-tools", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { "X-AI-Token": token } : {}),
			},
			body: JSON.stringify(body),
		}),
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.reauthConfigs.mockResolvedValue([]);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.verify.mockResolvedValue({
		valid: true,
		claims: { sub: "user-1", org: "example-org" },
	});
	mocks.configs.mockResolvedValue([
		{
			id: "config-1",
			displayName: "Example",
			mcpServer: { name: "Example Server" },
			encryptedApiKey: "secret-value",
		},
	]);
	client = {
		listTools: vi.fn().mockResolvedValue({ tools: [readTool] }),
		callTool: vi.fn().mockResolvedValue(result),
	};
	mocks.connect.mockResolvedValue({
		ok: true,
		client,
		serverName: "Example Server",
	});
});
afterEach(() => vi.restoreAllMocks());

describe("internal MCP tools", () => {
	it("requires a token", async () => {
		expect((await request(undefined, null)).status).toBe(401);
		expect(mocks.configs).not.toHaveBeenCalled();
	});
	it("rejects an invalid token", async () => {
		mocks.verify.mockResolvedValue({ valid: false });
		expect((await request()).status).toBe(401);
	});
	it("requires the token organization", async () => {
		mocks.verify.mockResolvedValue({
			valid: true,
			claims: { sub: "user-1" },
		});
		expect((await request()).status).toBe(403);
		expect(mocks.configs).not.toHaveBeenCalled();
		expect(mocks.connect).not.toHaveBeenCalled();
	});
	it.each([
		{ operation: "unknown" },
		null,
		[],
		{},
		{ ...callBody, arguments: [] },
		{ ...callBody, configId: "" },
		{ ...callBody, arguments: undefined },
	])("rejects a bad body: %j", async (body) => {
		expect((await request(body)).status).toBe(400);
		expect(mocks.connect).not.toHaveBeenCalled();
	});
	it("rejects malformed JSON", async () => {
		expect(
			(
				await POST(
					new Request("https://example.com", {
						method: "POST",
						headers: { "X-AI-Token": "synthetic-token" },
						body: "{",
					}),
				)
			).status,
		).toBe(400);
	});
	it("uses token identity for the query and each list client despite body identity", async () => {
		mocks.configs.mockResolvedValue([
			{ id: "config-1", displayName: "Example" },
			{ id: "config-2", displayName: "Example Two" },
		]);
		const response = await request({
			operation: "list",
			userId: "user-2",
			organizationId: "other-org",
		});
		expect(response.status).toBe(200);
		expect(mocks.configs).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "example-org",
		});
		for (const id of ["config-1", "config-2"]) {
			expect(mocks.connect).toHaveBeenCalledWith(
				id,
				"user-1",
				"example-org",
				{ access: "connect" },
			);
		}
		expect(mocks.close).toHaveBeenCalledTimes(2);
	});
	it("lists only explicit read-only tools across pages and omits credentials", async () => {
		client.listTools
			.mockResolvedValueOnce({
				tools: [
					{
						...readTool,
						name: "write",
						annotations: { readOnlyHint: false },
					},
					{ ...readTool, name: "unspecified", annotations: {} },
					{ name: "missing", inputSchema: {} },
					{
						...readTool,
						name: "invalid",
						annotations: { readOnlyHint: "true" },
					},
				],
				nextCursor: "page-2",
			})
			.mockResolvedValueOnce({ tools: [readTool] });
		const response = await request();
		expect(await response.json()).toEqual({
			unavailable: [],
			servers: [
				{
					configId: "config-1",
					name: "Example",
					serverName: "Example Server",
					tools: [readTool],
				},
			],
		});
		expect(client.listTools).toHaveBeenNthCalledWith(2, {
			params: { cursor: "page-2" },
		});
		expect(mocks.close).toHaveBeenCalledWith(client);
	});
	it("drops failed and inaccessible configs and closes a failed listing", async () => {
		mocks.configs.mockResolvedValue(
			[1, 2, 3, 4].map((id) => ({
				id: `config-${id}`,
				displayName: "Example",
			})),
		);
		const failedClient = {
			listTools: vi.fn().mockRejectedValue(new Error("secret-value")),
		};
		mocks.connect
			.mockRejectedValueOnce(new Error("secret-value"))
			.mockResolvedValueOnce({
				ok: false,
				error: {
					code: "CONFIG_NOT_FOUND",
					message: "Bearer secret-value",
				},
			})
			.mockResolvedValueOnce({ ok: true, client: failedClient })
			.mockResolvedValueOnce({
				ok: true,
				client,
				serverName: "Example Server",
			});
		const response = await request();
		expect(response.status).toBe(200);
		expect((await response.json()).servers).toHaveLength(1);
		expect(mocks.close).toHaveBeenCalledWith(failedClient);
		expect(mocks.close).toHaveBeenCalledWith(client);
		expect(
			JSON.stringify(vi.mocked(console.warn).mock.calls),
		).not.toContain("secret-value");
	});
	it("reports unavailable servers without connection or listing messages", async () => {
		mocks.configs.mockResolvedValue([
			{ id: "config-1", displayName: "Example Auth" },
			{ id: "config-2", mcpServer: { name: "Example Query" } },
		]);
		mocks.connect.mockResolvedValueOnce({
			ok: false,
			error: {
				code: "AUTH_FAILED",
				message: "https://example.com/wrapper",
			},
		});
		client.listTools.mockRejectedValueOnce(
			new McpClientError({
				code: "STDIO_WRAPPER_UNREACHABLE",
				message: "https://example.com/wrapper",
			}),
		);
		const response = await request();
		expect(await response.json()).toEqual({
			servers: [],
			unavailable: [
				{ name: "Example Auth", code: "AUTH_FAILED" },
				{ name: "Example Query", code: "STDIO_WRAPPER_UNREACHABLE" },
			],
		});
	});
	it("returns a bounded STDIO tool failure as 422", async () => {
		const message = "MCP call failed: Invalid query. ".repeat(40);
		client.callTool.mockRejectedValueOnce(
			new McpClientError({ code: "MCP_CALL_FAILED", message }),
		);
		const response = await request(callBody);
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "Tool call failed",
			code: "TOOL_ERROR",
			message: message.slice(0, 500),
		});
		expect(mocks.close).toHaveBeenCalledWith(client);
	});
	it.each(["STDIO_WRAPPER_UNREACHABLE", "STDIO_WRAPPER_ERROR"])(
		"keeps %s private during calls",
		async (code) => {
			client.callTool.mockRejectedValueOnce(
				new McpClientError({
					code,
					message: "https://example.com/wrapper",
				}),
			);
			const response = await request(callBody);
			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: "Unable to process MCP tools request",
				code: "INTERNAL_ERROR",
			});
			expect(
				JSON.stringify(vi.mocked(console.error).mock.calls),
			).not.toContain("https://example.com/wrapper");
		},
	);
	it("keeps STDIO failures private during the pre-call listing", async () => {
		client.listTools.mockRejectedValueOnce(
			new McpClientError({
				code: "MCP_CALL_FAILED",
				message: "private diagnostics",
			}),
		);
		const response = await request(callBody);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Unable to process MCP tools request",
			code: "INTERNAL_ERROR",
		});
		expect(client.callTool).not.toHaveBeenCalled();
	});
	it.each(["list-configs", "list-tools", "call-tool"])(
		"logs SDK numeric diagnostics at %s without private fields",
		async (stage) => {
			const error = new MCPClientError({
				code: -32602,
				statusCode: 503,
				message: "private diagnostics",
				url: "https://example.com/wrapper",
				data: { secret: "private diagnostics" },
			});
			if (stage === "list-configs") {
				mocks.configs.mockRejectedValueOnce(error);
			} else if (stage === "list-tools") {
				client.listTools.mockRejectedValueOnce(error);
			} else {
				client.callTool.mockRejectedValueOnce(error);
			}
			await request(stage === "call-tool" ? callBody : undefined);
			const logger =
				stage === "list-tools" ? console.warn : console.error;
			expect(logger).toHaveBeenCalledWith(
				"[Internal MCP Tools] Request failed",
				expect.objectContaining({
					stage,
					code: "MCPClientError",
					rpcCode: -32602,
					httpStatus: 503,
				}),
			);
			expect(JSON.stringify(vi.mocked(logger).mock.calls)).not.toContain(
				"private diagnostics",
			);
			expect(JSON.stringify(vi.mocked(logger).mock.calls)).not.toContain(
				"https://example.com/wrapper",
			);
		},
	);

	it("reports enabled OAuth configs needing reauth without connecting", async () => {
		mocks.configs.mockResolvedValueOnce([]);
		mocks.reauthConfigs.mockResolvedValueOnce([
			{ id: "example-reauth-1", displayName: "Example OAuth" },
			{ id: "example-reauth-2", mcpServer: { name: "Example Server" } },
			{ id: "example-reauth-3" },
		]);
		const response = await request();
		expect(await response.json()).toEqual({
			servers: [],
			unavailable: [
				{ name: "Example OAuth", code: "OAUTH_AUTH_REQUIRED" },
				{ name: "Example Server", code: "OAUTH_AUTH_REQUIRED" },
				{ name: "MCP Server", code: "OAUTH_AUTH_REQUIRED" },
			],
		});
		expect(mocks.reauthConfigs).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "example-org",
		});
		expect(mocks.connect).not.toHaveBeenCalled();
	});

	it("bounds repeated pagination cursors", async () => {
		client.listTools.mockResolvedValue({
			tools: [readTool],
			nextCursor: "same",
		});
		expect((await request()).status).toBe(200);
		expect(client.listTools).toHaveBeenCalledTimes(2);
		expect(mocks.close).toHaveBeenCalledWith(client);
	});
	it("bounds unique pagination cursors", async () => {
		let page = 0;
		client.listTools.mockImplementation(async () => ({
			tools: [],
			nextCursor: `${++page}`,
		}));
		expect((await request()).status).toBe(200);
		expect(client.listTools).toHaveBeenCalledTimes(100);
	});
	it("returns a generic 404 for a missing or inaccessible config", async () => {
		mocks.connect.mockResolvedValue({
			ok: false,
			error: { code: "CONFIG_NOT_FOUND", message: "Bearer secret-value" },
		});
		const response = await request(callBody);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "MCP configuration not found",
			code: "CONFIG_NOT_FOUND",
		});
		expect(client.callTool).not.toHaveBeenCalled();
	});
	it.each([false, undefined, "true"])(
		"refuses a tool without read-only true (%s)",
		async (hint) => {
			client.listTools.mockResolvedValue({
				tools: [{ ...readTool, annotations: { readOnlyHint: hint } }],
			});
			expect((await request(callBody)).status).toBe(403);
			expect(client.callTool).not.toHaveBeenCalled();
			expect(mocks.close).toHaveBeenCalledWith(client);
		},
	);
	it("refuses an absent tool", async () => {
		client.listTools.mockResolvedValue({ tools: [] });
		expect((await request(callBody)).status).toBe(403);
		expect(client.callTool).not.toHaveBeenCalled();
	});
	it("rechecks tools on the call client using token identity, calls and returns the raw result", async () => {
		client.listTools
			.mockResolvedValueOnce({ tools: [], nextCursor: "next" })
			.mockResolvedValueOnce({ tools: [readTool] });
		const response = await request({
			...callBody,
			userId: "user-2",
			organizationId: "other-org",
		});
		expect(response.status).toBe(200);
		expect(mocks.connect).toHaveBeenCalledWith(
			"config-1",
			"user-1",
			"example-org",
			{ access: "connect" },
		);
		expect(client.listTools.mock.invocationCallOrder[1]).toBeLessThan(
			client.callTool.mock.invocationCallOrder[0],
		);
		expect(client.callTool).toHaveBeenCalledWith({
			name: "query",
			arguments: { query: "select 1" },
		});
		expect(await response.json()).toEqual({ result });
		expect(mocks.close).toHaveBeenCalledWith(client);
	});
	it("closes after a thrown call and hides error details", async () => {
		client.callTool.mockRejectedValue(new Error("secret-value"));
		const response = await request(callBody);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Unable to process MCP tools request",
			code: "INTERNAL_ERROR",
		});
		expect(mocks.close).toHaveBeenCalledWith(client);
		expect(
			JSON.stringify(vi.mocked(console.error).mock.calls),
		).not.toContain("secret-value");
	});
	it("maps query failures to a generic 500", async () => {
		mocks.configs.mockRejectedValue(new Error("secret-value"));
		expect((await request()).status).toBe(500);
	});
	it("closes when the pre-call listing fails without executing the tool", async () => {
		client.listTools.mockRejectedValue(new Error("secret-value"));
		expect((await request(callBody)).status).toBe(500);
		expect(client.callTool).not.toHaveBeenCalled();
		expect(mocks.close).toHaveBeenCalledWith(client);
	});
	it.each([
		["MCP_PERMISSION_DENIED", 403],
		["ORGANIZATION_MEMBERSHIP_REQUIRED", 403],
		["OAUTH_AUTH_REQUIRED", 409],
		["CONFIG_DISABLED", 409],
		["AUTH_FAILED", 409],
		["API_KEY_MISSING", 409],
		["OAUTH_ERROR", 409],
		["INVALID_TWILIO_CREDENTIALS", 409],
		["RATE_LIMIT", 429],
		["OAUTH_REFRESH_FAILED", 502],
		["AUTH_ERROR", 502],
		["CONNECTION_ERROR", 502],
		["UNKNOWN", 502],
	])(
		"maps client failure %s to %i without exposing details",
		async (code, status) => {
			mocks.connect.mockResolvedValue({
				ok: false,
				error: { code, message: "Bearer secret-value" },
			});
			const response = await request(callBody);
			expect(response.status).toBe(status);
			const body = await response.json();
			expect(body.code).toBe(code);
			if (status === 409) {
				expect(body.error).toMatch(/reconnect.*Fabric/);
			}
			expect(JSON.stringify(body)).not.toContain("secret-value");
			expect(console.warn).toHaveBeenCalledWith(
				"[Internal MCP Tools] Request failed",
				{ stage: "call-tool", code },
			);
			expect(
				JSON.stringify(vi.mocked(console.warn).mock.calls),
			).not.toContain("secret-value");
			expect(client.callTool).not.toHaveBeenCalled();
		},
	);
	it("returns 422 for a remote protocol error and trims the server message", async () => {
		const message = "Invalid query parameter. ".repeat(40);
		client.callTool.mockRejectedValue(
			new MCPClientError({
				message,
				code: -32602,
				data: { credential: "Bearer secret-value" },
			}),
		);
		const response = await request(callBody);
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "Tool call failed",
			code: "TOOL_ERROR",
			message: message.slice(0, 500),
		});
		expect(mocks.close).toHaveBeenCalledWith(client);
		expect(console.error).toHaveBeenCalledWith(
			"[Internal MCP Tools] Request failed",
			{
				stage: "call-tool",
				serverName: "Example Server",
				code: "MCPClientError",
				rpcCode: -32602,
			},
		);
		expect(
			JSON.stringify(vi.mocked(console.error).mock.calls),
		).not.toContain("secret-value");
	});
	it("keeps an internal SDK failure generic", async () => {
		client.callTool.mockRejectedValue(
			new MCPClientError({
				message: "Bearer secret-value",
				statusCode: 500,
				responseBody: "private diagnostics",
			}),
		);
		const response = await request(callBody);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Unable to process MCP tools request",
			code: "INTERNAL_ERROR",
		});
		expect(
			JSON.stringify(vi.mocked(console.error).mock.calls),
		).not.toContain("secret-value");
	});
	it("returns an isError tool result untouched with status 200", async () => {
		const toolError = { ...result, isError: true };
		client.callTool.mockResolvedValue(toolError);
		const response = await request(callBody);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ result: toolError });
	});
	it("logs connection and tool-list failures by stage, server and code", async () => {
		mocks.connect.mockResolvedValueOnce({
			ok: false,
			error: { code: "AUTH_FAILED", message: "Bearer secret-value" },
		});
		expect((await request()).status).toBe(200);
		expect(console.warn).toHaveBeenCalledWith(
			"[Internal MCP Tools] Request failed",
			{ stage: "list-tools", serverName: "Example", code: "AUTH_FAILED" },
		);
		client.listTools.mockRejectedValueOnce(
			new McpClientError({
				code: "CONNECTION_ERROR",
				message: "Bearer secret-value",
			}),
		);
		expect((await request()).status).toBe(200);
		expect(console.warn).toHaveBeenCalledWith(
			"[Internal MCP Tools] Request failed",
			{
				stage: "list-tools",
				serverName: "Example",
				code: "CONNECTION_ERROR",
			},
		);
		expect(
			JSON.stringify(vi.mocked(console.warn).mock.calls),
		).not.toContain("secret-value");
	});
	it("logs query failures by stage and error name without the error message", async () => {
		mocks.configs.mockRejectedValueOnce(
			new TypeError("Bearer secret-value"),
		);
		expect((await request()).status).toBe(500);
		expect(console.error).toHaveBeenCalledWith(
			"[Internal MCP Tools] Request failed",
			{ stage: "list-configs", code: "TypeError" },
		);
		expect(
			JSON.stringify(vi.mocked(console.error).mock.calls),
		).not.toContain("secret-value");
	});
	it("logs a known server name from a failed call connection", async () => {
		mocks.connect.mockResolvedValueOnce({
			ok: false,
			error: {
				code: "AUTH_FAILED",
				message: "Bearer secret-value",
				serverName: "Example Server",
			},
		});
		expect((await request(callBody)).status).toBe(409);
		expect(console.warn).toHaveBeenCalledWith(
			"[Internal MCP Tools] Request failed",
			{
				stage: "call-tool",
				serverName: "Example Server",
				code: "AUTH_FAILED",
			},
		);
		expect(
			JSON.stringify(vi.mocked(console.warn).mock.calls),
		).not.toContain("secret-value");
	});
	it("keeps numeric protocol errors from listing generic and logs the list stage", async () => {
		client.listTools.mockRejectedValueOnce(
			new MCPClientError({
				code: -32602,
				message: "Bearer secret-value",
			}),
		);
		const response = await request(callBody);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Unable to process MCP tools request",
			code: "INTERNAL_ERROR",
		});
		expect(console.error).toHaveBeenCalledWith(
			"[Internal MCP Tools] Request failed",
			{
				stage: "list-tools",
				serverName: "Example Server",
				code: "MCPClientError",
				rpcCode: -32602,
			},
		);
		expect(client.callTool).not.toHaveBeenCalled();
	});
	it("does not treat an ordinary error carrying a numeric code as a remote protocol error", async () => {
		client.callTool.mockRejectedValueOnce(
			Object.assign(new Error("Bearer secret-value"), { code: -32602 }),
		);
		const response = await request(callBody);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Unable to process MCP tools request",
			code: "INTERNAL_ERROR",
		});
	});
});
