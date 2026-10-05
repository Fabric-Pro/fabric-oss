/**
 * The generic integration removals — "disconnect by type" and "delete
 * integration" — must take the one personal GitLab disconnect, not delete
 * the row: the connection is deactivated with its token gone, the
 * `gitlab-official` MCPConfig's token columns are cleared (a defence: they
 * are empty since migration 20261004120000) and its client registration is
 * kept for a reconnect, and the next read finds no token.
 *
 * The connection service and every reader are real; the database is the
 * GitLab fake that applies `where` clauses.
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

vi.mock("@repo/database", async () => {
	const { z } = await import("zod");
	const tenant = (organizationId?: string | null) =>
		organizationId ? { organizationId } : { organizationId: null };
	return {
		get db() {
			return state.fake.db;
		},
		GITLAB_PERSONAL_MCP_SERVER_KEYS: ["gitlab", "gitlab-official"],
		WorkflowIntegrationProviderSchema: z.string(),
		Prisma: { PrismaClientKnownRequestError: class extends Error {} },
		listProjectsBoundToIntegration: async () => [],
		getWorkflowIntegrationById: (
			id: string,
			userId: string,
			organizationId?: string,
		) =>
			state.fake.db.workflowIntegration.findFirst({
				where: { id, userId, ...tenant(organizationId) },
			}),
		deleteWorkflowIntegration: (
			id: string,
			userId: string,
			organizationId?: string,
		) =>
			state.fake.db.workflowIntegration.delete({
				where: { id, userId, ...tenant(organizationId) },
			}),
		deleteWorkflowIntegrationByType: async (
			provider: string,
			userId: string,
			organizationId?: string,
		) => {
			const { count } =
				await state.fake.db.workflowIntegration.deleteMany({
					where: {
						provider,
						userId,
						...tenant(organizationId),
						NOT: { name: `${provider}_OAUTH_APP` },
					},
				});
			return count > 0;
		},
	};
});

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

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ role: "member" }),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
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
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
	};
});

import {
	getGitLabAccessToken,
	resetGitLabConnectionDepsForTests,
} from "@repo/integrations/gitlab";
import { deleteIntegrationProcedure } from "../delete-integration";
import { disconnectByTypeProcedure } from "../disconnect-by-type";

type Handler = (args: {
	input: Record<string, unknown>;
	context: {
		user: { id: string };
		session: { activeOrganizationId: string };
	};
}) => Promise<{ success: boolean }>;

const handlerOf = (procedure: unknown) =>
	(procedure as { handler: Handler }).handler;

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

const dcrIssuer = {
	kind: "mcp-dcr",
	mcpConfigId: "cfg-official",
	serverKey: "gitlab-official",
	clientId: "dcr-client",
	origin: "https://gitlab.com",
};

/** Production's case: a connection issued by the official server's DCR client. */
function seedDcrConnection() {
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
				encryptedOauthClientSecret: null,
				dcrClientMetadata: { token_endpoint_auth_method: "none" },
				encryptedAccessToken: "enc:copy-access",
				encryptedRefreshToken: "enc:copy-refresh",
				tokenExpiresAt: new Date(Date.now() + 3_600_000),
				needsReauth: false,
				enabled: true,
				authType: "OAUTH2",
				createdAt: new Date("2026-01-01T00:00:00Z"),
				updatedAt: new Date("2026-01-01T00:00:00Z"),
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
					access_token: "copy-access",
					refresh_token: "copy-refresh",
					expires_in: 7200,
					token_obtained_at: new Date().toISOString(),
					issuer: dcrIssuer,
					connectionGeneration: 1,
				}),
				settings: {},
				createdAt: new Date("2026-01-01T00:00:00Z"),
				updatedAt: new Date("2026-01-01T00:00:00Z"),
			},
			{
				id: "wi-workflow",
				userId: "user-1",
				organizationId: "org-1",
				provider: "GITLAB",
				name: "GitLab (workflow)",
				workflowId: "wf-1",
				isActive: true,
				credentials: encryptedCredential({
					GITLAB_ACCESS_TOKEN: "glpat-wf",
				}),
				settings: {},
				createdAt: new Date("2026-01-01T00:00:00Z"),
				updatedAt: new Date("2026-01-01T00:00:00Z"),
			},
		],
	});
}

function expectDisconnected() {
	const personal = state.fake.tables.workflowIntegration.find(
		(row) => row.id === "wi-1",
	);
	expect(personal?.isActive).toBe(false);
	expect(readCredential(personal as never)).not.toHaveProperty(
		"access_token",
	);
	const copy = state.fake.tables.mCPConfig[0];
	expect(copy.encryptedAccessToken).toBeNull();
	expect(copy.encryptedRefreshToken).toBeNull();
	// The registration and the row stay: reconnecting reuses them.
	expect(copy.oauthClientId).toBe("dcr-client");
}

beforeEach(() => {
	resetGitLabConnectionDepsForTests();
	// Revocation at GitLab is best effort; answer it so nothing is left open.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200 })),
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("generic integration removal of the personal GitLab connection", () => {
	it("disconnect-by-type GITLAB disconnects the connection and the next read finds no token", async () => {
		seedDcrConnection();

		const result = await handlerOf(disconnectByTypeProcedure)({
			input: { type: "GITLAB", organizationId: "org-1" },
			context,
		});

		expect(result.success).toBe(true);
		expect(await getGitLabAccessToken("user-1", "org-1")).toBeNull();
		expectDisconnected();
		// Workflow-scoped credentials are removed as they always were.
		expect(
			state.fake.tables.workflowIntegration.some(
				(row) => row.id === "wi-workflow",
			),
		).toBe(false);
	});

	it("delete-integration on the personal row disconnects it and the next read finds no token", async () => {
		seedDcrConnection();

		const result = await handlerOf(deleteIntegrationProcedure)({
			input: { integrationId: "wi-1", organizationId: "org-1" },
			context,
		});

		expect(result.success).toBe(true);
		expect(await getGitLabAccessToken("user-1", "org-1")).toBeNull();
		expectDisconnected();
	});

	it("delete-integration on a workflow-scoped GitLab row still deletes just that row", async () => {
		seedDcrConnection();

		await handlerOf(deleteIntegrationProcedure)({
			input: { integrationId: "wi-workflow", organizationId: "org-1" },
			context,
		});

		expect(
			state.fake.tables.workflowIntegration.map((row) => row.id),
		).toEqual(["wi-1"]);
		expect(await getGitLabAccessToken("user-1", "org-1")).toBe(
			"copy-access",
		);
	});
});
