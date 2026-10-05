/**
 * Regression for issue #2795 on the document-editor path: a revoked GitLab
 * grant used to be retried on every request — one `/oauth/token` call per
 * request, forever, with no reconnect prompt — because the failure was never
 * recorded.
 *
 * The person's GitLab connection now carries that state itself. These tests
 * drive the REAL resolver and the REAL connection service (only GitLab's
 * token endpoint, the REST execution and the database are doubles), so the
 * assertion is that the connection is actually marked and the dead grant is
 * not posted again — not merely that some callback was handed over.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
	readCredential,
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

const executeGitLabToolMock = vi.hoisted(() => vi.fn());
vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	executeGitLabTool: executeGitLabToolMock,
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
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";

type Handler = (args: {
	input: {
		projectId: string;
		organizationId?: string | null;
		methodName: string;
		args: Record<string, unknown>;
	};
	context: { user: { id: string }; session: { id: string } };
}) => Promise<{ result: unknown }>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../execute-gitlab-tool");
	return (mod.executeGitLabToolProcedure as unknown as { handler: Handler })
		.handler;
}

// The project, in the organization whose GitLab connection the document
// route uses (never the input's or the session's).
const PROJECT_ROW = { id: "proj-1", organizationId: "org-1" };

const input = {
	projectId: "proj-1",
	organizationId: "org-1",
	methodName: "list_issues",
	args: {},
};
const context = { user: { id: "user-1" }, session: { id: "session-1" } };

/** A connection whose access token lapsed an hour ago, issued by the app. */
function seedExpiredConnection() {
	state.fake = createGitLabFakeDb({
		project: [PROJECT_ROW],
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
	executeGitLabToolMock.mockResolvedValue({ ok: true });
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("executeGitLabToolProcedure — a refresh failure is recorded on the connection", () => {
	it("marks the connection reconnect-required when GitLab rejects the grant, and never posts it again", async () => {
		const row = seedExpiredConnection();
		answerTokenEndpoint(400, { error: "invalid_grant" });
		const handler = await loadHandler();

		await expect(handler({ input, context })).rejects.toThrow(/GitLab/);
		expect(tokenCalls()).toHaveLength(1);
		expect(row.settings).toMatchObject({ needsReauth: true });

		// The next request reads the recorded state instead of re-posting.
		await expect(handler({ input, context })).rejects.toThrow(/GitLab/);
		expect(tokenCalls()).toHaveLength(1);
		expect(executeGitLabToolMock).not.toHaveBeenCalled();
	});

	it("keeps working on the current token, without condemning it, on a transient failure", async () => {
		const row = seedExpiredConnection();
		answerTokenEndpoint(503, { message: "unavailable" });
		const handler = await loadHandler();

		const result = await handler({ input, context });

		expect(result.result).toEqual({ ok: true });
		expect(executeGitLabToolMock).toHaveBeenCalledOnce();
		expect((row.settings as Record<string, unknown>).needsReauth).not.toBe(
			true,
		);
		expect(readCredential(row).refresh_token).toBe("live-refresh");
	});

	it("persists the rotated grant when the refresh succeeds", async () => {
		const row = seedExpiredConnection();
		answerTokenEndpoint(200, {
			access_token: "fresh-access",
			refresh_token: "fresh-refresh",
			expires_in: 7200,
			token_type: "bearer",
		});
		const handler = await loadHandler();

		await handler({ input, context });

		expect(tokenCalls()).toHaveLength(1);
		expect(readCredential(row)).toMatchObject({
			access_token: "fresh-access",
			refresh_token: "fresh-refresh",
		});
	});
});
