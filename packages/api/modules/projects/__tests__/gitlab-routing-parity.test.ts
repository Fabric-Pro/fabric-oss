import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<object>()),
	encryptApiKey: (v: string) => `enc:${v}`,
	decryptApiKey: (v: string) => v.replace(/^enc:/, ""),
}));

import {
	callMcpWithRestFallback,
	resolveGitLabSource,
} from "@repo/integrations/gitlab";

const ROUTED_METHODS = [
	"list_projects",
	"get_project",
	"list_issues",
	"get_issue",
	"list_merge_requests",
	"get_merge_request",
	"get_file_contents",
	"update_issue",
] as const;

/**
 * A person with a live GitLab connection that may use GitLab's official MCP
 * server, and that server's `gitlab-official` row. The resolver reads the
 * connection through the connection service; these are its database and
 * lock.
 */
function makeResolverArgs() {
	const connection = {
		id: "wi-1",
		userId: "u1",
		organizationId: null,
		provider: "GITLAB",
		name: "GitLab: dev",
		workflowId: null,
		isActive: true,
		credentials: `enc:${JSON.stringify({
			access_token: "tok",
			refresh_token: "ref",
			expires_in: 7200,
			token_obtained_at: new Date().toISOString(),
			issuer: {
				kind: "app",
				clientId: "app-client",
				origin: "https://gitlab.com",
			},
			connectionGeneration: 1,
		})}`,
		settings: { useOfficialMcp: true },
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	};
	const db = {
		workflowIntegration: {
			findMany: async () => [connection],
			create: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		mCPConfig: {
			findFirst: async () => ({
				id: "cfg",
				baseUrl: null,
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			}),
			updateMany: vi.fn(),
		},
		projectRepositoryIntegration: { findMany: async () => [] },
	};
	return {
		userId: "u1",
		organizationId: null as string | null,
		deps: {
			db: db as never,
			withLock: (async (
				_keys: unknown,
				fn: (tx: unknown, b: () => void) => unknown,
			) => fn(db, () => {})) as never,
		},
	};
}

describe("GitLab routing parity (MCP <> REST)", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});
	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it.each(ROUTED_METHODS)(
		"round-trips %s through the official MCP path",
		async (method) => {
			fetchSpy.mockImplementation(
				async () =>
					new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							result: { structuredContent: { method, ok: true } },
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
			);

			const source = await resolveGitLabSource(makeResolverArgs());
			expect(source?.kind).toBe("official-mcp");

			const out = await callMcpWithRestFallback({
				source: source!,
				method,
				args: {},
				restFallback: async () => ({ method, fromRest: true }),
			});
			expect(out).toMatchObject({ method, ok: true });
		},
	);

	it.each(ROUTED_METHODS)(
		"falls through to REST when MCP returns -32601 for %s",
		async (method) => {
			fetchSpy.mockImplementation(
				async () =>
					new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							error: {
								code: -32601,
								message: `Method not found: ${method}`,
							},
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
			);

			const source = await resolveGitLabSource(makeResolverArgs());
			const restFallback = vi.fn(async () => ({
				method,
				fromRest: true,
			}));
			const out = await callMcpWithRestFallback({
				source: source!,
				method,
				args: {},
				restFallback,
			});
			expect(out).toEqual({ method, fromRest: true });
			expect(restFallback).toHaveBeenCalledOnce();
		},
	);
});
