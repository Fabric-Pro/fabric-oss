/**
 * The GitLab REST fallback in the PM procedures is open only to a caller with
 * a usable personal GitLab connection — resolved through the GitLab
 * connection service. A legacy token copy on a `gitlab-official` MCP config
 * with no WorkflowIntegration row behind it is not a connection (nothing
 * adopts it on read). It, a reconnect-required connection, a teammate's
 * connection and the other tenant context's connection read as "not
 * connected".
 *
 * Each case reaches the REST gate the way production does when the caller
 * has no resolvable PM MCPConfig (`resolvePMConfigForUser` → null) on a
 * project wired to `key:gitlab-official`. The procedures and the connection
 * service are real; the database is the in-memory GitLab fake that applies
 * `where` clauses, with a project row beside it.
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
	project: null as Record<string, unknown> | null,
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<object>()),
	get db() {
		return {
			...state.fake.db,
			project: { findUnique: async () => state.project },
		};
	},
	resolvePMConfigForUser: async () => null,
	hasProjectAccess: async () => true,
	getStoryById: async () => null,
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

vi.mock("../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? undefined,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";
import { getPMCapabilitiesProcedure } from "../procedures/stories/sync/get-pm-capabilities";
import { syncStoryProcedure } from "../procedures/stories/sync/sync-story";
import { testPMSyncProcedure } from "../procedures/stories/sync/test-pm-sync";
import { getTestCasePmCapabilitiesProcedure } from "../procedures/test-cases/sync/get-test-case-pm-capabilities";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;
const handlerOf = (procedure: unknown) =>
	(procedure as { handler: Handler }).handler;

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
		enabled: true,
		authType: "OAUTH2",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	};
}

/** The scenarios every gate is checked against, in the project's org. */
const scenarios = {
	"legacy MCP copy only (no WI)": {
		mCPConfig: [officialCopy("user-2", "org-example")],
	},
	"own connection": {
		workflowIntegration: [personalRow("user-2", "org-example")],
	},
	"no connection": {},
	"reconnect-required": {
		workflowIntegration: [
			personalRow("user-2", "org-example", { needsReauth: true }),
		],
	},
	"teammate's connection only": {
		workflowIntegration: [personalRow("user-1", "org-example")],
		mCPConfig: [officialCopy("user-1", "org-example")],
	},
	"personal-context connection only": {
		workflowIntegration: [personalRow("user-2", null)],
	},
} as const;
const OPEN = ["own connection"];

function seed(name: keyof typeof scenarios) {
	state.fake = createGitLabFakeDb({
		mCPServer: [officialServer],
		...scenarios[name],
	});
}

const context = {
	user: { id: "user-2", name: "Dev" },
	session: { activeOrganizationId: "org-example" },
};

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 503 })),
	);
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	vi.stubEnv("FABRIC_FEATURE_TEST_CASES", "true");
	resetGitLabConnectionDepsForTests();
	state.project = {
		id: "proj-1",
		organizationId: "org-example",
		readOnlyMode: false,
		projectManagementMcpServerId: "key:gitlab-official",
		projectManagementMcpConfigId: null,
		projectManagementContainerId: "123",
		projectManagementContainerName: "example-group/widgets",
		projectManagementAdditionalContext: null,
	};
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe.each(Object.keys(scenarios) as Array<keyof typeof scenarios>)(
	"GitLab REST gate — %s",
	(name) => {
		const open = OPEN.includes(name);

		it(`getPMCapabilities ${open ? "offers" : "withholds"} GitLab REST`, async () => {
			seed(name);
			const result = await handlerOf(getPMCapabilitiesProcedure)({
				input: { projectId: "proj-1" },
				context,
			});
			expect(result.detectedType === "gitlab-rest").toBe(open);
		});

		it(`getTestCasePmCapabilities ${open ? "offers" : "withholds"} GitLab REST`, async () => {
			seed(name);
			const result = await handlerOf(getTestCasePmCapabilitiesProcedure)({
				input: { projectId: "proj-1" },
				context,
			});
			expect(result.detectedType === "gitlab-rest").toBe(open);
		});

		it(`syncStory ${open ? "passes" : "refuses at"} the connection gate`, async () => {
			seed(name);
			const outcome = handlerOf(syncStoryProcedure)({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					direction: "push",
					organizationId: "org-example",
				},
				context,
			});
			// Past the gate the next step looks the story up (absent here).
			await expect(outcome).rejects.toThrow(
				open
					? "Story not found"
					: "You have not connected your account",
			);
		});

		it(`testPMSync ${open ? "goes through GitLab REST" : "refuses as not connected"}`, async () => {
			seed(name);
			const outcome = handlerOf(testPMSyncProcedure)({
				input: { projectId: "proj-1" },
				context,
			});
			if (open) {
				// The REST attempt itself fails against the stubbed GitLab; what
				// matters is that the caller was let through to make it.
				await expect(outcome).resolves.toMatchObject({
					success: false,
				});
			} else {
				await expect(outcome).rejects.toThrow("You have not connected");
			}
		});
	},
);
