/**
 * The orchestrator offers the GitLab OAuth tools when the caller has a usable
 * personal GitLab connection. A legacy `gitlab-official` MCP token copy with
 * no connection row behind it is not a connection (nothing adopts it), and
 * neither a reconnect-required connection, a teammate's connection nor the
 * other tenant context's connection offers anything.
 *
 * Drives the real `loadMcpTools` with MCP servers switched off (so only the
 * OAuth integration tools load) against the real GitLab connection service
 * and an in-memory database that applies `where` clauses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "../../../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("../../../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db").createGitLabFakeDb
	>,
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<object>()),
	get db() {
		return {
			...state.fake.db,
			userOrchestratorPreferences: { findUnique: async () => null },
		};
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
		"../../../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db"
	);
	return {
		...(await importOriginal<object>()),
		encryptApiKey: helpers.fakeEncrypt,
		decryptApiKey: helpers.fakeDecrypt,
	};
});

// The real GitLab registry entry advertises its tools dynamically (an empty
// static list), so give it one static tool here to make the gate observable.
vi.mock("@repo/mcp-registry", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/mcp-registry")>();
	return {
		...actual,
		GITLAB_ACCOUNT: {
			...actual.GITLAB_ACCOUNT,
			mcps: actual.GITLAB_ACCOUNT.mcps.map((mcp) => ({
				...mcp,
				tools: [
					{
						name: "list_issues",
						description: "List issues",
						inputSchema: { type: "object", properties: {} },
					},
				],
			})),
		},
	};
});

import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";
import { loadMcpTools } from "../tool-loader";

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
		// Off for MCP discovery here, so only the OAuth tools can load.
		enabled: false,
		authType: "OAUTH2",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	};
}

function seed(tables: Parameters<typeof createGitLabFakeDb>[0] = {}) {
	state.fake = createGitLabFakeDb({ mCPServer: [officialServer], ...tables });
}

async function gitlabToolNames(userId: string, organizationId: string | null) {
	const loaded = await loadMcpTools({
		step: {},
		userId,
		organizationId,
		// MCP servers explicitly switched off: only OAuth integration tools.
		enabledMcpConfigIds: [],
	} as never);
	return Object.entries(loaded.toolToConfig)
		.filter(([, info]) => info.configId.startsWith("gitlab-connected:"))
		.map(([name]) => name);
}

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn());
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	resetGitLabConnectionDepsForTests();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadMcpTools — GitLab OAuth tools", () => {
	it("offers none for a legacy gitlab-official MCP token copy with no connection, and adopts nothing", async () => {
		seed({ mCPConfig: [officialCopy("user-2", "org-example")] });

		expect(await gitlabToolNames("user-2", "org-example")).toEqual([]);
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
	});

	it("offers them for the caller's own connection", async () => {
		seed({ workflowIntegration: [personalRow("user-2", "org-example")] });

		expect(
			(await gitlabToolNames("user-2", "org-example")).length,
		).toBeGreaterThan(0);
	});

	it("offers none without a connection, for a teammate's connection, or across tenant contexts", async () => {
		seed({
			workflowIntegration: [
				personalRow("user-1", "org-example"),
				personalRow("user-2", null),
			],
			mCPConfig: [officialCopy("user-1", "org-example")],
		});

		expect(await gitlabToolNames("user-2", "org-example")).toEqual([]);
		expect(await gitlabToolNames("user-3", "org-example")).toEqual([]);
	});

	it("offers none for a reconnect-required connection", async () => {
		seed({
			workflowIntegration: [
				personalRow("user-2", "org-example", { needsReauth: true }),
			],
		});

		expect(await gitlabToolNames("user-2", "org-example")).toEqual([]);
	});
});
