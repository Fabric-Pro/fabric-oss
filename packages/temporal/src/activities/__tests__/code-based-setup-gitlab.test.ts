/**
 * Code-based setup finds the caller's GitLab connection through the GitLab
 * connection service. A legacy `gitlab-official` MCP token copy with no
 * connection row behind it is not a connection (nothing adopts it), and a
 * reconnect-required connection, a teammate's connection and the other tenant
 * context's connection do not count either.
 *
 * Real activities and connection service; the database is the in-memory
 * GitLab fake that applies `where` clauses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db").createGitLabFakeDb
	>,
	projectCredential: { source: "none" } as Record<string, unknown>,
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<object>()),
	get db() {
		return state.fake.db;
	},
	findProjectRepoCredentials: async () => state.projectCredential,
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
		"../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db"
	);
	return {
		...(await importOriginal<object>()),
		encryptApiKey: helpers.fakeEncrypt,
		decryptApiKey: helpers.fakeDecrypt,
	};
});

import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";
import {
	findGitLabOAuthConfig,
	findMcpConfigsForRepos,
} from "../code-based-setup";

const officialServer = {
	id: "srv-official",
	key: "gitlab-official",
	defaultUrl: "https://gitlab.com/api/v4/mcp",
};
const REPO = "https://gitlab.com/example-group/widgets";

function personalRow(
	userId: string,
	organizationId: string | null,
	settings: Record<string, unknown> = {},
) {
	return {
		id: `wi-${userId}-${organizationId ?? "personal"}`,
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

function seed(tables: Parameters<typeof createGitLabFakeDb>[0] = {}) {
	state.fake = createGitLabFakeDb({ mCPServer: [officialServer], ...tables });
}

/** The id of the seeded connection row. */
function connectionId(userId: string, organizationId: string | null) {
	const row = state.fake.tables.workflowIntegration.find(
		(each) =>
			each.userId === userId && each.organizationId === organizationId,
	);
	return row?.id;
}

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn());
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	resetGitLabConnectionDepsForTests();
	state.projectCredential = { source: "none" };
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("findGitLabOAuthConfig", () => {
	it("resolves the caller's own connection", async () => {
		seed({ workflowIntegration: [personalRow("user-2", "org-example")] });

		const result = await findGitLabOAuthConfig({
			userId: "user-2",
			organizationId: "org-example",
		});

		const id = connectionId("user-2", "org-example");
		expect(id).toBe("wi-user-2-org-example");
		expect(result).toEqual({
			oauthConfigId: `oauth-gitlab:${id}`,
			integrationId: id,
		});
	});

	it("rejects with not-connected for a legacy gitlab-official MCP token copy alone, and adopts nothing", async () => {
		seed({ mCPConfig: [officialCopy("user-2", "org-example")] });

		await expect(
			findGitLabOAuthConfig({
				userId: "user-2",
				organizationId: "org-example",
			}),
		).rejects.toThrow("GitLab is not connected");
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
	});

	it("rejects with not-connected for no connection, a teammate's, or the other tenant context's", async () => {
		seed({
			workflowIntegration: [
				personalRow("user-1", "org-example"),
				personalRow("user-2", null),
			],
			mCPConfig: [officialCopy("user-1", "org-example")],
		});

		await expect(
			findGitLabOAuthConfig({
				userId: "user-2",
				organizationId: "org-example",
			}),
		).rejects.toThrow("GitLab is not connected");
		expect(await findGitLabOAuthConfig({ userId: "user-2" })).toMatchObject(
			{ integrationId: "wi-user-2-personal" },
		);
	});

	it("rejects with not-connected for a reconnect-required connection", async () => {
		seed({
			workflowIntegration: [
				personalRow("user-2", "org-example", { needsReauth: true }),
			],
		});

		await expect(
			findGitLabOAuthConfig({
				userId: "user-2",
				organizationId: "org-example",
			}),
		).rejects.toThrow("GitLab is not connected");
	});
});

describe("findMcpConfigsForRepos — GitLab repositories", () => {
	it("maps a GitLab repository through the caller's connection (user-level path)", async () => {
		seed({ workflowIntegration: [personalRow("user-2", "org-example")] });

		const result = await findMcpConfigsForRepos({
			repoUrls: [REPO],
			userId: "user-2",
			organizationId: "org-example",
		});

		expect(result.mappings).toEqual([
			{
				repoUrl: REPO,
				mcpConfigId: `oauth-gitlab:${connectionId("user-2", "org-example")}`,
				provider: "gitlab",
			},
		]);
	});

	it("uses the caller's connection for tool definitions beside a project repository grant", async () => {
		seed({ workflowIntegration: [personalRow("user-2", "org-example")] });
		state.projectCredential = { source: "project", integrationId: "pri-1" };

		const result = await findMcpConfigsForRepos({
			repoUrls: [REPO],
			userId: "user-2",
			organizationId: "org-example",
			projectId: "proj-1",
		});

		const toolConfig = `oauth-gitlab:${connectionId("user-2", "org-example")}`;
		expect(result.mappings).toEqual([
			{
				repoUrl: REPO,
				mcpConfigId: toolConfig,
				provider: "gitlab",
				projectIntegrationId: "pri-1",
			},
		]);
		expect(result.allMcpConfigIds).toContain(toolConfig);
	});

	it("skips GitLab repositories for a reconnect-required, absent or legacy-copy-only connection", async () => {
		seed({
			workflowIntegration: [
				personalRow("user-2", "org-example", { needsReauth: true }),
				personalRow("user-1", "org-example"),
			],
			mCPConfig: [officialCopy("user-4", "org-example")],
		});

		for (const userId of ["user-2", "user-3", "user-4"]) {
			const result = await findMcpConfigsForRepos({
				repoUrls: [REPO],
				userId,
				organizationId: "org-example",
			});
			expect(result.mappings).toEqual([]);
		}
	});
});
