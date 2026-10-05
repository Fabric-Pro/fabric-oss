/**
 * Regression for issue #2795 on the project-picker path. The picker is polled
 * by the UI, so a revoked grant that was never recorded produced one
 * `/oauth/token` call per render, none of them surfacing a reconnect prompt.
 *
 * The person's GitLab connection now carries that state itself. These tests
 * drive the REAL resolver and the REAL connection service (only GitLab's
 * token endpoint, the REST helpers and the database are doubles). The
 * procedure's own MCP/REST branching is covered in `list-projects.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "../../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("../../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db").createGitLabFakeDb
	>,
}));

vi.mock("@repo/database", () => ({
	get db() {
		return state.fake.db;
	},
	hasProjectAccess: async () => true,
}));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (
		keys: string | readonly string[],
		fn: (
			tx: unknown,
			assertBudget: (ms: number) => void,
		) => Promise<unknown>,
	) => state.fake.withLock(keys, fn as never),
}));

vi.mock("@repo/utils", async (importOriginal) => {
	const helpers = await import(
		"../../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db"
	);
	return {
		...(await importOriginal<object>()),
		encryptApiKey: helpers.fakeEncrypt,
		decryptApiKey: helpers.fakeDecrypt,
	};
});

const getAuthenticatedUserMock = vi.hoisted(() => vi.fn());
const listUserProjectsMock = vi.hoisted(() => vi.fn());
vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getAuthenticatedUser: getAuthenticatedUserMock,
	listUserProjects: listUserProjectsMock,
}));

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
		// The real resolver's rule for the organization a request names (the
		// input's, else the session's; an explicit null suppresses the session
		// fallback; none refused when required). Membership and role are
		// exercised for real in gitlab-request-authorization.test.ts.
		authorizeInputOrganization: async (
			_permission: string,
			orgId: string | null | undefined,
			ctx: { session?: { activeOrganizationId?: string | null } },
			opts?: { requireOrganization?: boolean },
		) => {
			const resolved =
				orgId ||
				(orgId === null
					? undefined
					: ctx.session?.activeOrganizationId || undefined);
			if (!resolved && opts?.requireOrganization) {
				throw new Error(
					"This operation requires an organization context",
				);
			}
			return resolved;
		},
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";

type Handler = (args: {
	input: { organizationId?: string | null };
	context: { user: { id: string }; session: { id: string } };
}) => Promise<{ configured: boolean; error: string | null | undefined }>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../list-projects");
	return (mod.listGitLabProjectsProcedure as unknown as { handler: Handler })
		.handler;
}

// The organization the request acts in: a person's GitLab connection lives
// in one (ADR-018), and a request with none is refused before any read.
const input = { organizationId: "org-1" };
const context = { user: { id: "user-1" }, session: { id: "session-1" } };

/** A connection whose access token lapsed an hour ago, issued by the app. */
function seedExpiredConnection() {
	state.fake = createGitLabFakeDb({
		workflowIntegration: [
			{
				id: "wi-1",
				userId: "user-1",
				organizationId: "org-1",
				provider: "GITLAB",
				name: "GitLab: dev",
				workflowId: null,
				isActive: true,
				credentials: encryptedCredential({
					access_token: "stale-access",
					refresh_token: "live-refresh",
					expires_in: 7200,
					token_obtained_at: new Date(
						Date.now() - 3 * 3_600_000,
					).toISOString(),
					issuer: {
						kind: "app",
						clientId: "app-client",
						origin: "https://gitlab.com",
					},
					connectionGeneration: 1,
				}),
				settings: {},
				createdAt: new Date("2026-01-01T00:00:00Z"),
				updatedAt: new Date("2026-01-01T00:00:00Z"),
			},
		],
	});
	return state.fake.tables.workflowIntegration[0];
}

const fetchMock = vi.fn();
const tokenCalls = () =>
	fetchMock.mock.calls.filter(([url]) =>
		String(url).endsWith("/oauth/token"),
	);
const answerTokenEndpoint = (status: number, body: unknown) =>
	fetchMock.mockImplementation(async (url: string) =>
		String(url).endsWith("/oauth/token")
			? new Response(JSON.stringify(body), { status })
			: new Response("unexpected", { status: 599 }),
	);

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "app-secret");
	resetGitLabConnectionDepsForTests();
	getAuthenticatedUserMock.mockResolvedValue({ login: "example-user" });
	listUserProjectsMock.mockResolvedValue([]);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("listGitLabProjectsProcedure — a refresh failure is recorded on the connection", () => {
	it("marks the connection reconnect-required when GitLab rejects the grant, and never posts it again", async () => {
		const row = seedExpiredConnection();
		answerTokenEndpoint(400, { error: "invalid_grant" });
		const handler = await loadHandler();

		const first = await handler({ input, context });
		expect(first.configured).toBe(false);
		expect(tokenCalls()).toHaveLength(1);
		expect(row.settings).toMatchObject({ needsReauth: true });

		const second = await handler({ input, context });
		expect(second.configured).toBe(false);
		expect(tokenCalls()).toHaveLength(1);
	});

	it("still renders from the current token, without condemning it, on a transient failure", async () => {
		const row = seedExpiredConnection();
		answerTokenEndpoint(503, { message: "unavailable" });
		const handler = await loadHandler();

		const result = await handler({ input, context });

		expect(result.configured).toBe(true);
		expect(result.error).toBeNull();
		expect(getAuthenticatedUserMock).toHaveBeenCalledWith({
			token: "stale-access",
			apiBase: "https://gitlab.com/api/v4",
		});
		expect((row.settings as Record<string, unknown>).needsReauth).not.toBe(
			true,
		);
	});
});

describe("listGitLabProjectsProcedure — official MCP capability loss", () => {
	it("answers over REST when the official MCP endpoint answers 404, and records the loss", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [
				{
					id: "srv-official",
					key: "gitlab-official",
					defaultUrl: "https://gitlab.com/api/v4/mcp",
				},
			],
			mCPConfig: [
				{
					id: "cfg-official",
					userId: "user-1",
					organizationId: "org-1",
					mcpServerId: "srv-official",
					baseUrl: null,
					oauthClientId: "dcr-client",
					enabled: true,
				},
			],
			workflowIntegration: [
				{
					id: "wi-1",
					userId: "user-1",
					organizationId: "org-1",
					provider: "GITLAB",
					name: "GitLab: dev",
					workflowId: null,
					isActive: true,
					credentials: encryptedCredential({
						access_token: "live-access",
						refresh_token: "live-refresh",
						expires_in: 7200,
						token_obtained_at: new Date().toISOString(),
						issuer: {
							kind: "app",
							clientId: "app-client",
							origin: "https://gitlab.com",
						},
						connectionGeneration: 1,
					}),
					settings: { useOfficialMcp: true },
					createdAt: new Date("2026-01-01T00:00:00Z"),
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				},
			],
		});
		fetchMock.mockResolvedValueOnce(
			new Response("404 Not Found", { status: 404 }),
		);
		const handler = await loadHandler();

		const result = await handler({ input, context });

		expect(String(fetchMock.mock.calls[0][0])).toBe(
			"https://gitlab.com/api/v4/mcp",
		);
		expect(result).toMatchObject({ configured: true, error: null });
		expect(getAuthenticatedUserMock).toHaveBeenCalledWith({
			token: "live-access",
			apiBase: "https://gitlab.com/api/v4",
		});
		expect(state.fake.tables.workflowIntegration[0].settings).toMatchObject(
			{ useOfficialMcp: false, mcpProbe: { status: "not-found" } },
		);
		// The registration is kept.
		expect(state.fake.tables.mCPConfig).toHaveLength(1);
	});
});
