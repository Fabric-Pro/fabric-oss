/**
 * Saving a GitLab personal access token through the integrations settings
 * form REPLACES the person's GitLab connection: nothing of a previous OAuth
 * grant — its refresh token, its issuing client, a reconnect-required mark,
 * the capability flags probed for it — survives into the PAT credential.
 * Merging the PAT into the old credential left a refresh token and an OAuth
 * issuer beside a token they never issued.
 *
 * The connection service and every reader are real; the database is the
 * GitLab fake that applies `where` clauses. The generic integration helpers
 * the other providers use are implemented over the same rows, so the old
 * merge path is observable here too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
	fakeDecrypt,
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
	listWorkflowIntegrations: async (args: {
		userId: string;
		organizationId?: string | null;
	}) =>
		state.fake.tables.workflowIntegration.filter(
			(row) =>
				row.userId === args.userId &&
				row.organizationId === (args.organizationId ?? null),
		),
	updateWorkflowIntegration: async (
		id: string,
		data: Record<string, unknown>,
	) => {
		const row = state.fake.tables.workflowIntegration.find(
			(r) => r.id === id,
		);
		Object.assign(row ?? {}, data);
		return row;
	},
	createWorkflowIntegration: async (data: Record<string, unknown>) => {
		const row = { id: `wi-new-${Date.now()}`, workflowId: null, ...data };
		state.fake.tables.workflowIntegration.push(row as never);
		return row;
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
	};
});

import {
	getGitLabAccessToken,
	resetGitLabConnectionDepsForTests,
} from "@repo/integrations/gitlab";
import { saveIntegrationProcedure } from "../save-integration";

type Handler = (args: {
	input: {
		type: string;
		credentials: Record<string, string>;
		organizationId?: string | null;
	};
	context: {
		user: { id: string };
		session: { activeOrganizationId: string | null };
	};
}) => Promise<{ success: boolean; integrationId: string }>;

const handler = (saveIntegrationProcedure as unknown as { handler: Handler })
	.handler;

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

function seedOAuthConnection() {
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
				needsReauth: true,
				oauthClientId: "dcr-client",
				encryptedAccessToken: null,
				encryptedRefreshToken: null,
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
					access_token: "oauth-access",
					refresh_token: "oauth-refresh",
					expires_in: 7200,
					token_obtained_at: new Date().toISOString(),
					issuer: {
						kind: "app",
						clientId: "app-client",
						origin: "https://gitlab.com",
					},
					connectionGeneration: 4,
				}),
				settings: {
					needsReauth: true,
					reauthReason: "invalid_grant",
					useOfficialMcp: true,
					mcpProbe: { status: "ok" },
				},
				createdAt: new Date("2026-01-01T00:00:00Z"),
				updatedAt: new Date("2026-01-01T00:00:00Z"),
			},
		],
	});
	return state.fake.tables.workflowIntegration[0];
}

function settingsHasRefreshToken(row: { settings?: unknown }) {
	return (row.settings as Record<string, unknown>).hasRefreshToken;
}

beforeEach(() => {
	resetGitLabConnectionDepsForTests();
	vi.stubGlobal("fetch", vi.fn());
});

describe("saveIntegration — GitLab personal access token", () => {
	it("replaces an OAuth grant cleanly: no refresh token, issuer or reauth mark survives", async () => {
		const row = seedOAuthConnection();

		const result = await handler({
			input: {
				type: "GITLAB",
				credentials: { GITLAB_ACCESS_TOKEN: "glpat-example" },
				organizationId: "org-1",
			},
			context,
		});

		expect(result.success).toBe(true);
		expect(result.integrationId).toBe("wi-1");
		const credential = readCredential(row);
		expect(credential.refresh_token).toBeUndefined();
		expect(credential.expires_in).toBeUndefined();
		expect(credential.token_obtained_at).toBeUndefined();
		expect(credential.GITLAB_ACCESS_TOKEN).toBe("glpat-example");
		// The PAT is mirrored into `access_token` so no reader can still pick
		// up the replaced OAuth token from that field.
		expect(credential.access_token).toBe("glpat-example");
		expect(settingsHasRefreshToken(row)).toBe(false);
		expect(credential.issuer).toEqual({
			kind: "pat",
			origin: "https://gitlab.com",
		});
		// A new connection generation fences any refresh still holding the
		// old grant.
		expect(credential.connectionGeneration).toBe(5);
		const settings = row.settings as Record<string, unknown>;
		expect(settings.needsReauth).not.toBe(true);
		expect(settings).not.toHaveProperty("useOfficialMcp");
		expect(settings).not.toHaveProperty("mcpProbe");
		// The MCP breaker that described the old grant is cleared too.
		expect(state.fake.tables.mCPConfig[0].needsReauth).toBe(false);
		// And every reader now gets the PAT, without any token exchange.
		expect(await getGitLabAccessToken("user-1", "org-1")).toBe(
			"glpat-example",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("records a self-hosted instance as the PAT's origin", async () => {
		const row = seedOAuthConnection();

		await handler({
			input: {
				type: "GITLAB",
				credentials: {
					GITLAB_ACCESS_TOKEN: "glpat-example",
					GITLAB_URL: "https://gitlab.example.com/",
				},
				organizationId: "org-1",
			},
			context,
		});

		expect(readCredential(row).issuer).toEqual({
			kind: "pat",
			origin: "https://gitlab.example.com",
		});
	});

	it("reads the instance from the older `domain` field too", async () => {
		const row = seedOAuthConnection();

		await handler({
			input: {
				type: "GITLAB",
				credentials: {
					GITLAB_ACCESS_TOKEN: "glpat-example",
					domain: "gitlab.example.com",
				},
				organizationId: "org-1",
			},
			context,
		});

		expect(readCredential(row).issuer).toEqual({
			kind: "pat",
			origin: "https://gitlab.example.com",
		});
	});

	it.each([
		"https://169.254.169.254",
		"https://127.0.0.1",
		"https://10.0.0.5",
		"http://gitlab.example.com",
		"not a url ::",
	])(
		"refuses %s as the instance — never recorded, never defaulted to gitlab.com",
		async (address) => {
			const row = seedOAuthConnection();
			const before = fakeDecrypt(String(row.credentials));

			await expect(
				handler({
					input: {
						type: "GITLAB",
						credentials: {
							GITLAB_ACCESS_TOKEN: "glpat-example",
							GITLAB_URL: address,
						},
						organizationId: "org-1",
					},
					context,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(fakeDecrypt(String(row.credentials))).toBe(before);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("leaves the connection unchanged when the form re-submits a masked token", async () => {
		const row = seedOAuthConnection();
		const before = fakeDecrypt(String(row.credentials));

		const result = await handler({
			input: {
				type: "GITLAB",
				credentials: { GITLAB_ACCESS_TOKEN: "••••••••" },
				organizationId: "org-1",
			},
			context,
		});

		expect(result).toMatchObject({ success: true, integrationId: "wi-1" });
		expect(fakeDecrypt(String(row.credentials))).toBe(before);
	});
});
