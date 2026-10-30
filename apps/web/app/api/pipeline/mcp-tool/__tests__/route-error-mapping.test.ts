import { MCPClientError, McpClientError } from "@repo/mcp";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	authorize: vi.fn(),
	connect: vi.fn(),
	call: vi.fn(),
	invalidate: vi.fn(),
}));
vi.mock("@saas/auth/lib/server", () => ({ getSession: mocks.session }));
vi.mock("@saas/mcp/lib/authorize-mcp-config-request", () => ({
	authorizeMcpConfigRequest: mocks.authorize,
}));
vi.mock("@repo/mcp", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/mcp")>()),
	getCachedMcpClientForConfig: mocks.connect,
	callMcpTool: mocks.call,
	invalidateMcpClientCache: mocks.invalidate,
}));
vi.mock("@repo/database", () => ({ getMcpConfigById: vi.fn() }));

import { POST } from "../route";

const url = "http://mcp-stdio-wrapper.internal.example.com:8080";
const wrapperError = () =>
	new McpClientError({
		code: "STDIO_WRAPPER_UNREACHABLE",
		message: `Failed to reach ${url}`,
	});
const connection = (tools: () => Promise<unknown>) => ({
	client: { tools },
	serverName: "Example",
});
const executeError = (error: unknown) =>
	mocks.connect.mockResolvedValue(
		connection(async () => ({
			example_tool: {
				execute: async () => {
					throw error;
				},
			},
		})),
	);
async function response() {
	const res = await POST(
		new NextRequest("http://example.com/api/pipeline/mcp-tool", {
			method: "POST",
			body: JSON.stringify({
				mcpConfigId: "example-config",
				toolName: "example_tool",
			}),
		}),
	);
	return { status: res.status, body: await res.json() };
}
describe("MCP tool route error responses", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.session.mockResolvedValue({ user: { id: "example-user" } });
		mocks.authorize.mockResolvedValue({ ok: true });
		mocks.invalidate.mockResolvedValue(undefined);
		mocks.call.mockImplementation(async ({ execute }) => execute());
	});
	it("hides wrapper URL on first tools attempt", async () => {
		mocks.connect.mockResolvedValue(
			connection(async () => {
				throw wrapperError();
			}),
		);
		const { status, body } = await response();
		expect(status).toBe(502);
		expect(body.code).toBe("STDIO_WRAPPER_UNREACHABLE");
		expect(JSON.stringify(body)).not.toContain(url);
	});
	it("hides wrapper URL on retry tools attempt", async () => {
		mocks.connect
			.mockResolvedValueOnce(
				connection(async () => {
					throw new Error("stale");
				}),
			)
			.mockResolvedValueOnce(
				connection(async () => {
					throw wrapperError();
				}),
			);
		const { status, body } = await response();
		expect(status).toBe(502);
		expect(body.code).toBe("STDIO_WRAPPER_UNREACHABLE");
		expect(JSON.stringify(body)).not.toContain(url);
	});
	it("hides wrapper URL during execution", async () => {
		executeError(wrapperError());
		const { status, body } = await response();
		expect(status).toBe(502);
		expect(body.code).toBe("STDIO_WRAPPER_UNREACHABLE");
		expect(JSON.stringify(body)).not.toContain(url);
	});
	it("hides non-MCP retry details", async () => {
		mocks.connect
			.mockRejectedValueOnce(new Error("stale"))
			.mockRejectedValueOnce(new Error("private retry detail"));
		const { status, body } = await response();
		expect(status).toBe(500);
		expect(body.code).toBe("INTERNAL_ERROR");
		expect(JSON.stringify(body)).not.toContain("private retry detail");
	});
	it.each(["wrapper", "sdk"])(
		"returns bounded %s tool errors",
		async (kind) => {
			const message = `page not found ${"x".repeat(600)}`;
			executeError(
				kind === "wrapper"
					? new McpClientError({
							code: "MCP_CALL_FAILED",
							message: `MCP call failed: ${message}`,
						})
					: new MCPClientError({ message, code: -32603 }),
			);
			const { status, body } = await response();
			expect(status).toBe(422);
			expect(body.code).toBe("TOOL_ERROR");
			expect(body.error).toBe(message.slice(0, 500));
		},
	);
	it("returns bounded in-band tool error text", async () => {
		const message = `page not found ${"x".repeat(600)}`;
		mocks.connect.mockResolvedValue(
			connection(async () => ({
				example_tool: {
					execute: async () => ({
						isError: true,
						content: [{ type: "text", text: message }],
					}),
				},
			})),
		);
		const { status, body } = await response();
		expect(status).toBe(422);
		expect(body.code).toBe("TOOL_ERROR");
		expect(body.error).toBe(message.slice(0, 500));
	});
	it("returns a fallback for in-band errors without text", async () => {
		mocks.connect.mockResolvedValue(
			connection(async () => ({
				example_tool: { execute: async () => ({ isError: true }) },
			})),
		);
		const { status, body } = await response();
		expect(status).toBe(422);
		expect(body.code).toBe("TOOL_ERROR");
		expect(body.error).toBe("MCP tool returned an error");
	});
	it("preserves token expiry response", async () => {
		executeError(new Error("upstream 401"));
		const { status, body } = await response();
		expect(status).toBe(401);
		expect(body.code).toBe("AUTH_TOKEN_EXPIRED");
		expect(body.error).toBe(
			"Authentication failed. Your access token may be expired or revoked. Please update it in MCP Settings.",
		);
	});
	it("preserves rate limit and retryAfter", async () => {
		mocks.connect.mockRejectedValue(
			new McpClientError({
				code: "RATE_LIMIT",
				message: "private",
				isRateLimitError: true,
				retryAfter: 42,
			}),
		);
		const { status, body } = await response();
		expect(status).toBe(429);
		expect(body.code).toBe("RATE_LIMIT");
		expect(body.retryAfter).toBe(42);
		expect(body.error).not.toContain("private");
	});
	it("maps execution authentication errors to 401", async () => {
		executeError(
			new McpClientError({
				code: "AUTH_ERROR",
				message: "private auth detail",
				isAuthError: true,
			}),
		);
		const { status, body } = await response();
		expect(status).toBe(401);
		expect(body.code).toBe("AUTH_ERROR");
		expect(body.error).not.toContain("private");
	});
	it("maps SDK transport errors to 502", async () => {
		executeError(
			new MCPClientError({ message: "private transport detail" }),
		);
		const { status, body } = await response();
		expect(status).toBe(502);
		expect(body.code).toBe("CONNECTION_ERROR");
		expect(body.error).not.toContain("private");
	});
});
