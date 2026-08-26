import {
	callMcpWithRestFallback,
	resolveGitLabSource,
} from "@repo/integrations/gitlab";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function makeResolverDeps() {
	return {
		userId: "u1",
		organizationId: null as string | null,
		db: {
			mCPConfig: {
				findFirst: async () => ({
					id: "cfg",
					baseUrl: null,
					encryptedAccessToken: "enc",
					tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
					mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
				}),
			},
			workflowIntegration: {
				findFirst: async () => null,
			},
		} as never,
		decrypt: () => "tok",
		refresh: async () => "tok",
		getRestToken: async () => null as string | null,
		// Required by the resolver: a caller that omits the writer degrades to
		// REST while persisting nothing, so the next request refreshes the same
		// dead token again (issue #2795). These cases never fail a refresh, so
		// an explicit no-op is the honest wiring.
		markRefreshFailure: vi.fn(async () => {}),
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

			const source = await resolveGitLabSource(makeResolverDeps());
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

			const source = await resolveGitLabSource(makeResolverDeps());
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
