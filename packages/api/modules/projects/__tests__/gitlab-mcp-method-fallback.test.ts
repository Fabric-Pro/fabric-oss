import {
	callMcpWithRestFallback,
	GitLabMcpError,
	GitLabMcpMethodNotFoundError,
} from "@repo/integrations/gitlab";
import { describe, expect, it, vi } from "vitest";

describe("callMcpWithRestFallback", () => {
	it("returns the MCP result on success", async () => {
		const callTool = vi.fn(async () => ({ ok: true }));
		const restFallback = vi.fn();
		const result = await callMcpWithRestFallback({
			source: { kind: "official-mcp", callTool },
			method: "list_projects",
			args: {},
			restFallback,
		});
		expect(result).toEqual({ ok: true });
		expect(restFallback).not.toHaveBeenCalled();
	});

	it("falls back to REST on JSON-RPC -32601", async () => {
		const callTool = vi.fn(async () => {
			throw new GitLabMcpMethodNotFoundError(
				"Method not found: get_file_contents",
			);
		});
		const restFallback = vi.fn(async () => ({ from: "rest" }));
		const result = await callMcpWithRestFallback({
			source: { kind: "official-mcp", callTool },
			method: "get_file_contents",
			args: {},
			restFallback,
		});
		expect(result).toEqual({ from: "rest" });
		expect(restFallback).toHaveBeenCalledOnce();
	});

	it("falls back to REST on a network error", async () => {
		const callTool = vi.fn(async () => {
			throw new Error("fetch failed");
		});
		const restFallback = vi.fn(async () => ({ from: "rest" }));
		const result = await callMcpWithRestFallback({
			source: { kind: "official-mcp", callTool },
			method: "list_projects",
			args: {},
			restFallback,
		});
		expect(result).toEqual({ from: "rest" });
	});

	it("rethrows non-fallback MCP errors (e.g. -32602 invalid params)", async () => {
		const callTool = vi.fn(async () => {
			throw new GitLabMcpError("invalid params", -32602);
		});
		const restFallback = vi.fn();
		await expect(
			callMcpWithRestFallback({
				source: { kind: "official-mcp", callTool },
				method: "list_projects",
				args: {},
				restFallback,
			}),
		).rejects.toThrow("invalid params");
		expect(restFallback).not.toHaveBeenCalled();
	});

	it("delegates straight to REST when the source is rest-adapter", async () => {
		const restFallback = vi.fn(async () => ({ from: "rest" }));
		const result = await callMcpWithRestFallback({
			source: { kind: "rest-adapter", token: "tok" },
			method: "list_projects",
			args: {},
			restFallback,
		});
		expect(result).toEqual({ from: "rest" });
		expect(restFallback).toHaveBeenCalledOnce();
	});
});
