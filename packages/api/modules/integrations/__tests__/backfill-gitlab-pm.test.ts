/**
 * The GitLab PM backfill's `--dry-run` changes nothing: it reads each
 * configuring person's connection exactly as stored and reports what a real
 * run would try. A legacy `gitlab-official` MCP token copy is not a
 * connection, so a person whose only GitLab credential is one has no usable
 * connection here, exactly as a real run would find.
 *
 * The connection service is real; the database is the in-memory GitLab fake.
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
		"../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db"
	);
	return {
		...(await importOriginal<object>()),
		encryptApiKey: helpers.fakeEncrypt,
		decryptApiKey: helpers.fakeDecrypt,
	};
});

import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";
import { backfillGitLabPm } from "../lib/backfill-gitlab-pm";

const officialServer = {
	id: "srv-official",
	key: "gitlab-official",
	defaultUrl: "https://gitlab.com/api/v4/mcp",
};

/** Production's DCR shape: a usable grant on the MCP copy, no WI row. */
function dcrOnlyCopy() {
	return {
		id: "cfg-official",
		userId: "user-2",
		organizationId: "org-example",
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

function seed(repositoryUrl: string | null) {
	state.fake = createGitLabFakeDb({
		mCPServer: [officialServer],
		mCPConfig: [dcrOnlyCopy()],
		project: [{ id: "proj-1", organizationId: "org-example" }],
		projectRepositoryIntegration: [
			{
				id: "pri-1",
				projectId: "proj-1",
				provider: "GITLAB",
				status: "ACTIVE",
				configuredByUserId: "user-2",
				repositoryOwner: "acme",
				repositoryName: "widgets",
				repositoryUrl,
			},
		],
	});
}

const fetchMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	resetGitLabConnectionDepsForTests();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("backfillGitLabPm — dry run", () => {
	it("reports a person whose only GitLab credential is a legacy MCP copy as not connected, and writes nothing", async () => {
		seed("https://gitlab.com/acme/widgets");
		const before = structuredClone(state.fake.tables);
		const lines: string[] = [];

		const result = await backfillGitLabPm({
			dryRun: true,
			log: (line) => lines.push(line),
		});

		expect(result).toEqual({ wired: 0, skipped: 1, failed: 0 });
		expect(
			lines.some((line) =>
				line.includes("no usable personal GitLab connection"),
			),
		).toBe(true);
		// Nothing adopted, nothing written, nothing sent.
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
		expect(state.fake.tables).toEqual(before);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports a repository on another instance than the connection as skipped", async () => {
		seed("https://gitlab.com/acme/widgets");
		state.fake.tables.mCPConfig.length = 0;
		state.fake.tables.workflowIntegration.push({
			id: "wi-2",
			userId: "user-2",
			organizationId: "org-example",
			provider: "GITLAB",
			name: "GitLab: dev",
			workflowId: null,
			isActive: true,
			credentials: encryptedCredential({
				access_token: "instance-access",
				refresh_token: "instance-refresh",
				expires_in: 7200,
				token_obtained_at: new Date().toISOString(),
				issuer: {
					kind: "app",
					clientId: "app-client",
					origin: "https://gitlab.example.com",
				},
				connectionGeneration: 1,
			}),
			settings: {},
			createdAt: new Date("2026-01-01T00:00:00Z"),
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		});
		const before = structuredClone(state.fake.tables);
		const lines: string[] = [];

		const result = await backfillGitLabPm({
			dryRun: true,
			log: (line) => lines.push(line),
		});

		expect(result).toEqual({ wired: 0, skipped: 1, failed: 0 });
		expect(
			lines.some((line) => line.includes("another GitLab instance")),
		).toBe(true);
		expect(state.fake.tables).toEqual(before);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports a stored connection on the repository's instance as wireable, and writes nothing", async () => {
		seed("https://gitlab.com/acme/widgets");
		state.fake.tables.workflowIntegration.push({
			id: "wi-2",
			userId: "user-2",
			organizationId: "org-example",
			provider: "GITLAB",
			name: "GitLab: dev",
			workflowId: null,
			isActive: true,
			credentials: encryptedCredential({
				access_token: "dotcom-access",
				refresh_token: "dotcom-refresh",
				expires_in: 7200,
				token_obtained_at: new Date().toISOString(),
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
		});
		const before = structuredClone(state.fake.tables);
		const lines: string[] = [];

		const result = await backfillGitLabPm({
			dryRun: true,
			log: (line) => lines.push(line),
		});

		expect(result).toEqual({ wired: 1, skipped: 0, failed: 0 });
		expect(
			lines.some((line) => line.includes("would try to wire PM")),
		).toBe(true);
		expect(state.fake.tables).toEqual(before);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
