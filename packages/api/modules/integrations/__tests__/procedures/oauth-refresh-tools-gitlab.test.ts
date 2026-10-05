/**
 * `oauth.refreshTools` for GitLab re-ingests the GitLab tool catalog for the
 * caller's usable personal GitLab connection, found through the GitLab
 * connection service. A legacy token copy on a `gitlab-official` MCP config
 * is not a connection (nothing adopts it), so it, like a reconnect-required,
 * absent or teammate's connection, reads "GitLab not connected".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db").createGitLabFakeDb
	>,
}));

const ingestion = vi.hoisted(() => ({
	tools: vi.fn(async () => ({ workflowId: "wf-tools" })),
	servers: vi.fn(async () => ({ workflowId: "wf-servers" })),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<object>()),
	get db() {
		return state.fake.db;
	},
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
		"../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db"
	);
	return {
		...(await importOriginal<object>()),
		encryptApiKey: helpers.fakeEncrypt,
		decryptApiKey: helpers.fakeDecrypt,
	};
});

vi.mock("@repo/temporal", () => ({
	triggerOAuthToolIngestion: ingestion.tools,
	triggerOAuthServerIngestion: ingestion.servers,
}));

vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		protectedProcedure: builder,
		// The resolution `authorizeInputOrganization` performs (input, else
		// session; an explicit null suppresses the session fallback; none
		// refused when required). It models no guest write organization
		// (`effectiveWriteOrgId`), which the real resolver lets win even over
		// an explicit null. Membership and role are exercised for real in
		// gitlab-request-authorization.test.ts.
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
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? undefined,
		resolveOrganizationIdForCaller: async (orgId: string | null) => orgId,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
	};
});

import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";
import { genericOAuthProcedures } from "../../procedures/oauth";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<{ success: boolean; message: string }>;
const refreshTools = (
	genericOAuthProcedures.refreshTools as unknown as { handler: Handler }
).handler;

const officialServer = {
	id: "srv-official",
	key: "gitlab-official",
	defaultUrl: "https://gitlab.com/api/v4/mcp",
};

function personalRow(
	userId: string,
	organizationId: string | null,
	settings: Record<string, unknown> = {},
) {
	return {
		id: `wi-${userId}`,
		userId,
		organizationId,
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
		settings,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	};
}

function officialCopy(userId: string, organizationId: string | null) {
	return {
		id: `cfg-official-${userId}`,
		userId,
		organizationId,
		mcpServerId: officialServer.id,
		baseUrl: null,
		oauthClientId: "dcr-client",
		encryptedOauthClientSecret: null,
		dcrClientMetadata: { token_endpoint_auth_method: "none" },
		encryptedAccessToken: "enc:dcr-access",
		encryptedRefreshToken: "enc:dcr-refresh",
		tokenExpiresAt: new Date(Date.now() + 3_600_000),
		needsReauth: false,
		enabled: true,
		authType: "OAUTH2",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	};
}

const call = () =>
	refreshTools({
		input: { provider: "GITLAB", organizationId: "org-example" },
		context: {
			user: { id: "user-2" },
			session: { activeOrganizationId: "org-example" },
		},
	});

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", vi.fn());
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	resetGitLabConnectionDepsForTests();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("oauth.refreshTools — GitLab", () => {
	it("refreshes tools for the person's own connection", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			workflowIntegration: [personalRow("user-2", "org-example")],
		});

		const result = await call();

		expect(result.success).toBe(true);
		const connection = state.fake.tables.workflowIntegration[0];
		expect(ingestion.tools).toHaveBeenCalledWith(
			expect.objectContaining({
				integrationId: connection.id,
				userId: "user-2",
				organizationId: "org-example",
			}),
		);
	});

	it.each([
		["no connection", {}],
		[
			"only a legacy gitlab-official MCP token copy (nothing adopts it)",
			{ mCPConfig: [officialCopy("user-2", "org-example")] },
		],
		[
			"a reconnect-required connection",
			{
				workflowIntegration: [
					personalRow("user-2", "org-example", { needsReauth: true }),
				],
			},
		],
		[
			"only a teammate's connection",
			{
				workflowIntegration: [personalRow("user-1", "org-example")],
				mCPConfig: [officialCopy("user-1", "org-example")],
			},
		],
		[
			"only a personal-context connection",
			{ workflowIntegration: [personalRow("user-2", null)] },
		],
	])("reports GitLab not connected for %s", async (_name, tables) => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			...tables,
		});

		const result = await call();

		expect(result).toMatchObject({
			success: false,
			message: expect.stringContaining("not connected"),
		});
		expect(ingestion.tools).not.toHaveBeenCalled();
	});
});
