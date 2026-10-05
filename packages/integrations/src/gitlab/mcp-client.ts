/**
 * Stateless one-shot JSON-RPC client for GitLab's official MCP server.
 *
 * Each callTool invocation opens a fresh tools/call request against
 * serverUrl. The session-managed orchestrator dispatcher
 * (packages/temporal/.../execute-mcp-tool.ts) is bound to the agent
 * runtime and is the wrong fit for the source-resolver path, which needs
 * a synchronous one-shot.
 */

import { gitlabOutboundFetch } from "./outbound";

export class GitLabMcpError extends Error {
	constructor(
		message: string,
		readonly code?: number,
		/** HTTP status when the error originated from a non-OK HTTP response (vs a JSON-RPC error). */
		readonly httpStatus?: number,
		/**
		 * Provenance of `httpStatus`: true only when the endpoint URL itself
		 * answered it, with no redirect involved. A redirect — refused
		 * (`redirect: "manual"` surfaces it as a 3xx) or followed by some
		 * other fetch — leaves this false, so the status says nothing about
		 * whether the call ran.
		 */
		readonly answeredByEndpoint: boolean = false,
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

function sameUrl(a: string, b: string): boolean {
	try {
		return new URL(a).href === new URL(b).href;
	} catch {
		return false;
	}
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
			// The endpoint is the user's GitLab instance: anything but
			// gitlab.com goes through the outbound guard. Redirects are never
			// followed — a POST that was redirected may already have run, and
			// a status from wherever it led says nothing about the endpoint.
			const response = await gitlabOutboundFetch(opts.serverUrl, {
				redirect: "manual",
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
				const isRedirect =
					response.status >= 300 && response.status < 400;
				const answeredByEndpoint =
					!isRedirect &&
					!response.redirected &&
					(!response.url || sameUrl(response.url, opts.serverUrl));
				throw new GitLabMcpError(
					isRedirect
						? `GitLab MCP HTTP ${response.status}: the endpoint redirected; not followed`
						: `GitLab MCP HTTP ${response.status}: ${await response.text().catch(() => "")}`,
					undefined, // no JSON-RPC error code on HTTP non-OK
					response.status, // capture the HTTP status for downstream classification
					answeredByEndpoint,
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
