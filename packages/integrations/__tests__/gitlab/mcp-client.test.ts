import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabMcpClient,
	GitLabMcpError,
	GitLabMcpMethodNotFoundError,
} from "../../src/gitlab/mcp-client";

describe("createGitLabMcpClient", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("dispatches tools/call and returns the structured content", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: { structuredContent: [{ id: 1, name: "p" }] },
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const client = createGitLabMcpClient({
			serverUrl: "https://gitlab.example.com/api/mcp",
			token: "test-token",
		});

		const result = await client.callTool("list_projects", { per_page: 5 });

		expect(result).toEqual([{ id: 1, name: "p" }]);

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://gitlab.example.com/api/mcp");
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer test-token");
		// Spec-compliant Accept for MCP Streamable HTTP (2025-03-26)
		expect(headers.accept).toBe("application/json, text/event-stream");

		const body = JSON.parse(init.body as string);
		expect(body.method).toBe("tools/call");
		expect(body.params.name).toBe("list_projects");
		expect(body.params.arguments).toEqual({ per_page: 5 });
	});

	it("throws GitLabMcpMethodNotFoundError on JSON-RPC error code -32601", async () => {
		fetchSpy.mockImplementation(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						error: { code: -32601, message: "Method not found" },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			),
		);

		const client = createGitLabMcpClient({
			serverUrl: "https://gitlab.example.com/api/mcp",
			token: "test-token",
		});

		const error = await client
			.callTool("unknown_method", {})
			.catch((e) => e);
		expect(error).toBeInstanceOf(GitLabMcpMethodNotFoundError);
		expect(error.message).toBe("Method not found");
		expect(error.code).toBe(-32601);
	});

	it("uses a per-client id counter starting at 1 for each new client", async () => {
		fetchSpy.mockImplementation(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: { structuredContent: null },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			),
		);

		const clientA = createGitLabMcpClient({
			serverUrl: "https://gitlab.example.com/api/mcp",
			token: "test-token",
		});
		await clientA.callTool("list_projects", {});
		await clientA.callTool("list_projects", {});
		await clientA.callTool("list_projects", {});

		const clientB = createGitLabMcpClient({
			serverUrl: "https://gitlab.example.com/api/mcp",
			token: "test-token",
		});
		await clientB.callTool("list_projects", {});

		const calls = fetchSpy.mock.calls as Array<[string, RequestInit]>;
		const idOf = (call: [string, RequestInit]) =>
			JSON.parse(call[1].body as string).id as number;

		// clientA's three calls use ids 1, 2, 3
		expect(idOf(calls[0])).toBe(1);
		expect(idOf(calls[1])).toBe(2);
		expect(idOf(calls[2])).toBe(3);
		// clientB starts its own sequence at 1, not 4
		expect(idOf(calls[3])).toBe(1);
	});

	it("throws GitLabMcpError on non-2xx HTTP response", async () => {
		fetchSpy.mockImplementation(() =>
			Promise.resolve(
				new Response("Bad Gateway", {
					status: 502,
					headers: { "content-type": "text/plain" },
				}),
			),
		);

		const client = createGitLabMcpClient({
			serverUrl: "https://gitlab.example.com/api/mcp",
			token: "test-token",
		});

		const error = await client
			.callTool("list_projects", {})
			.catch((e) => e);
		expect(error).toBeInstanceOf(GitLabMcpError);
		expect(error.message).toContain("GitLab MCP HTTP 502");
	});
});
