/**
 * Regression for issue #2795 on the project-picker path.
 *
 * `listGitLabProjectsProcedure` passes a `refresh` closure to
 * `resolveGitLabSource` but used to pass no `markRefreshFailure`. Because the
 * picker is polled by the UI, a revoked grant produced one `/oauth/token`
 * call per render, none of them recorded and none of them surfacing the
 * reconnect banner.
 *
 * These tests drive the REAL resolver and the REAL failure writer (only the
 * refresh and the REST helpers are faked) so the assertion is that the row is
 * actually written, not merely that a callback was handed over. The
 * procedure's own MCP/REST branching is covered in `list-projects.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDb,
	mcpConfigFindFirst,
	mcpConfigUpdate,
	mcpConfigUpdateMany,
	workflowIntegrationFindFirst,
	refreshMcpConfigTokenMock,
	getGitLabAccessTokenMock,
	getAuthenticatedUserMock,
	listUserProjectsMock,
} = vi.hoisted(() => {
	const mcpConfigFindFirst = vi.fn();
	const mcpConfigUpdate = vi.fn().mockResolvedValue(undefined);
	// Every write the failure writer makes is conditional — the condemning one
	// on the row still holding the rejected refresh token, all of them on the
	// row still being uncondemned — so they land on `updateMany`. `update`
	// stays stubbed so a regression back to an unconditional write shows up as
	// a called mock rather than a TypeError.
	const mcpConfigUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
	const workflowIntegrationFindFirst = vi.fn();
	return {
		mcpConfigFindFirst,
		mcpConfigUpdate,
		mcpConfigUpdateMany,
		workflowIntegrationFindFirst,
		mockDb: {
			mCPConfig: {
				findFirst: mcpConfigFindFirst,
				update: mcpConfigUpdate,
				updateMany: mcpConfigUpdateMany,
			},
			workflowIntegration: { findFirst: workflowIntegrationFindFirst },
		},
		refreshMcpConfigTokenMock: vi.fn(),
		getGitLabAccessTokenMock: vi.fn(async () => "rest-token"),
		getAuthenticatedUserMock: vi.fn(async () => ({
			login: "example-user",
		})),
		listUserProjectsMock: vi.fn(async () => []),
	};
});

vi.mock("@repo/database", () => ({
	db: mockDb,
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (s: string) => s,
	encryptApiKey: (s: string) => s,
	hashApiKey: (s: string) => `hash:${s}`,
}));

// Keep the real resolver, the real failure writer and the real error classes
// — only the outbound calls (token refresh, REST reads) are faked, so the
// classification and the write are the code under test.
vi.mock("@repo/integrations/gitlab", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@repo/integrations/gitlab")>();
	return {
		...actual,
		refreshMcpConfigToken: refreshMcpConfigTokenMock,
		getGitLabAccessToken: getGitLabAccessTokenMock,
		getAuthenticatedUser: getAuthenticatedUserMock,
		listUserProjects: listUserProjectsMock,
	};
});

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { GitLabReauthRequiredError } from "@repo/integrations/gitlab";

type Handler = (args: {
	input: { organizationId?: string | null };
	context: { user: { id: string }; session: { id: string } };
}) => Promise<{ configured: boolean; error: string | null | undefined }>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../list-projects");
	return (mod.listGitLabProjectsProcedure as unknown as { handler: Handler })
		.handler;
}

const input = { organizationId: null };
const context = { user: { id: "user-1" }, session: { id: "session-1" } };

beforeEach(() => {
	vi.clearAllMocks();
	mcpConfigUpdate.mockResolvedValue(undefined);
	mcpConfigUpdateMany.mockResolvedValue({ count: 1 });
	getGitLabAccessTokenMock.mockResolvedValue("rest-token");
	getAuthenticatedUserMock.mockResolvedValue({ login: "example-user" });
	listUserProjectsMock.mockResolvedValue([]);
	// A config whose access token has lapsed, so the resolver must refresh.
	workflowIntegrationFindFirst.mockResolvedValue({
		settings: { useOfficialMcp: true },
	});
	mcpConfigFindFirst.mockResolvedValue({
		id: "cfg-1",
		baseUrl: "https://gitlab.example.com/api/v4/mcp",
		encryptedAccessToken: "enc-access",
		encryptedRefreshToken: "enc-refresh",
		tokenExpiresAt: new Date(Date.now() - 60_000),
		mcpServer: { defaultUrl: "https://gitlab.example.com/api/v4/mcp" },
	});
});

describe("listGitLabProjectsProcedure — refresh failure is persisted", () => {
	it("trips the breaker when GitLab positively rejected the grant", async () => {
		refreshMcpConfigTokenMock.mockRejectedValue(
			new GitLabReauthRequiredError(),
		);

		const handler = await loadHandler();
		const result = await handler({ input, context });

		// The picker still renders from REST — the breaker must not cost the
		// user their working fallback.
		expect(result.configured).toBe(true);
		expect(result.error).toBeNull();

		expect(mcpConfigUpdate).not.toHaveBeenCalled();
		expect(mcpConfigUpdateMany).toHaveBeenCalledOnce();
		const arg = mcpConfigUpdateMany.mock.calls[0]![0];
		// Gated on the ciphertext the rejected refresh was posted with, so a
		// parallel rotation that lands first leaves the live credential alone.
		expect(arg.where).toEqual({
			id: "cfg-1",
			encryptedRefreshToken: "enc-refresh",
			// ...and on the breaker, so a row condemned by a concurrent
			// failure keeps the diagnostics of the failure that tripped it.
			needsReauth: false,
		});
		expect(arg.data).toMatchObject({
			needsReauth: true,
			lastRefreshError: "NEEDS_REAUTH",
			refreshFailureCount: { increment: 1 },
		});
		expect(arg.data.lastRefreshFailedAt).toBeInstanceOf(Date);
	});

	it("records diagnostics without condemning the credential on a transient failure", async () => {
		refreshMcpConfigTokenMock.mockRejectedValue(
			new Error("GitLab token refresh failed: 503"),
		);

		const handler = await loadHandler();
		await handler({ input, context });

		expect(mcpConfigUpdate).not.toHaveBeenCalled();
		expect(mcpConfigUpdateMany).toHaveBeenCalledOnce();
		const arg = mcpConfigUpdateMany.mock.calls[0]![0];
		// Conditional too, on the breaker rather than the token: a 5xx is no
		// evidence about a row version, but it must still decline against a
		// row condemned since the config was read.
		expect(arg.where).toEqual({ id: "cfg-1", needsReauth: false });
		// Absent, not `false` — writing false would clear a flag an earlier
		// real revocation had set.
		expect(arg.data).not.toHaveProperty("needsReauth");
		expect(arg.data).toMatchObject({
			lastRefreshError: "GitLab token refresh failed: 503",
			refreshFailureCount: { increment: 1 },
		});
	});
});
