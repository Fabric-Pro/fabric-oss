/**
 * Stateless one-shot JSON-RPC client for GitLab's official MCP server.
 *
 * Each callTool invocation opens a fresh tools/call request against
 * serverUrl. The session-managed orchestrator dispatcher
 * (packages/temporal/.../execute-mcp-tool.ts) is bound to the agent
 * runtime and is the wrong fit for the source-resolver path, which needs
 * a synchronous one-shot.
 */

export class GitLabMcpError extends Error {
	constructor(
		message: string,
		readonly code?: number,
		/** HTTP status when the error originated from a non-OK HTTP response (vs a JSON-RPC error). */
		readonly httpStatus?: number,
	) {
		super(message);
		this.name = "GitLabMcpError";
	}
}

export class GitLabMcpMethodNotFoundError extends GitLabMcpError {
	constructor(message: string) {
		super(message, -32601);
		this.name = "GitLabMcpMethodNotFoundError";
	}
}

export interface GitLabMcpClient {
	callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: number;
	result: { structuredContent?: unknown; content?: unknown };
}

interface JsonRpcError {
	jsonrpc: "2.0";
	id: number;
	error: { code: number; message: string; data?: unknown };
}

export function createGitLabMcpClient(opts: {
	serverUrl: string;
	token: string;
}): GitLabMcpClient {
	// Per-client JSON-RPC id counter. JSON-RPC 2.0 requires per-session
	// uniqueness of `id`; a module-global counter would be shared across
	// every client created in the same process, causing id collisions
	// under concurrency from multiple users.
	let nextId = 1;
	return {
		async callTool(name, args) {
			const id = nextId++;
			const response = await fetch(opts.serverUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					// Spec-compliant Accept for MCP Streamable HTTP
					// (2025-03-26): the server may respond with either
					// JSON or SSE. We do not consume SSE here, but
					// listing it satisfies the spec.
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${opts.token}`,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			});

			if (!response.ok) {
				throw new GitLabMcpError(
					`GitLab MCP HTTP ${response.status}: ${await response.text().catch(() => "")}`,
					undefined, // no JSON-RPC error code on HTTP non-OK
					response.status, // capture the HTTP status for downstream classification
				);
			}

			const body = (await response.json()) as
				| JsonRpcSuccess
				| JsonRpcError;
			if ("error" in body) {
				if (body.error.code === -32601) {
					throw new GitLabMcpMethodNotFoundError(body.error.message);
				}
				throw new GitLabMcpError(body.error.message, body.error.code);
			}
			return body.result.structuredContent ?? body.result.content;
		},
	};
}
