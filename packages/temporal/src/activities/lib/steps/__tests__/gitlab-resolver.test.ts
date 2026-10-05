/**
 * Regression for issue #2795 on the workflow-step path. A step that resolved
 * GitLab against a revoked grant used to degrade to REST while persisting
 * nothing, so the next activity refreshed the same dead token again. Each
 * caller had to remember to wire a failure writer; the step resolver was one
 * of the places that could forget.
 *
 * The person's GitLab connection now records that state itself, so there is
 * nothing left for a caller to wire. These tests drive the REAL step resolver,
 * the REAL source resolver and the REAL connection service; only GitLab's
 * token endpoint and the database are doubles.
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

import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";
import {
	resolveGitLabRestTokenForStep,
	resolveGitLabSourceForStep,
} from "../gitlab-resolver";
import { executeGitLabSearchIssuesStep } from "../gitlab-search-issues";

/** A connection whose access token lapsed an hour ago, issued by the app. */
function seedExpiredConnection(organizationId: string | null = "org-1") {
	state.fake = createGitLabFakeDb({
		workflowIntegration: [
			{
				id: "wi-1",
				userId: "user-1",
				organizationId,
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
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("resolveGitLabSourceForStep — a refresh failure is recorded on the connection", () => {
	it("marks the connection reconnect-required when GitLab rejects the grant, and never posts it again", async () => {
		const row = seedExpiredConnection();
		answerTokenEndpoint(400, { error: "invalid_grant" });

		const first = await resolveGitLabSourceForStep({
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(first).toBeNull();
		expect(tokenCalls()).toHaveLength(1);
		expect(row.settings).toMatchObject({ needsReauth: true });

		const second = await resolveGitLabSourceForStep({
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(second).toBeNull();
		expect(tokenCalls()).toHaveLength(1);
	});

	it("uses the current token, without condemning it, on a transient failure", async () => {
		const row = seedExpiredConnection();
		answerTokenEndpoint(503, { message: "unavailable" });

		const source = await resolveGitLabSourceForStep({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(source).toMatchObject({
			kind: "rest-adapter",
			credential: {
				token: "stale-access",
				apiBase: "https://gitlab.com/api/v4",
			},
		});
		expect((row.settings as Record<string, unknown>).needsReauth).not.toBe(
			true,
		);
	});

	it("resolves only the caller's connection in the given organization (exclusive tenant)", async () => {
		seedExpiredConnection(null);
		answerTokenEndpoint(200, {
			access_token: "fresh-access",
			refresh_token: "fresh-refresh",
			expires_in: 7200,
		});

		// The connection lives in the null (fail-closed) arm only; an org-scoped
		// step must not reach it.
		expect(
			await resolveGitLabSourceForStep({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).toBeNull();
		expect(
			await resolveGitLabRestTokenForStep({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).toBeNull();
		expect(tokenCalls()).toHaveLength(0);
	});
});

describe("a self-hosted credential on the step REST path", () => {
	function seedSelfHostedPat() {
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
						GITLAB_ACCESS_TOKEN: "instance-private-token",
						GITLAB_URL: "https://gitlab.example.com",
						access_token: "instance-private-token",
						issuer: {
							kind: "pat",
							origin: "https://gitlab.example.com",
						},
						connectionGeneration: 1,
					}),
					settings: {},
					createdAt: new Date("2026-01-01T00:00:00Z"),
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				},
			],
		});
	}

	it("sends the step's REST request to the credential's own instance", async () => {
		seedSelfHostedPat();
		fetchMock.mockResolvedValue(
			new Response("[]", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const result = await executeGitLabSearchIssuesStep({
			nodeConfig: { projectId: "group/app", search: "bug" },
			inputs: {},
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toMatch(
			/^https:\/\/gitlab\.example\.com\/api\/v4\/projects\/group%2Fapp\/issues\?/,
		);
		expect(init.headers as Record<string, string>).toMatchObject({
			Authorization: "Bearer instance-private-token",
		});
	});

	it("resolves the REST credential with its instance for the official-MCP fallback", async () => {
		seedSelfHostedPat();

		expect(
			await resolveGitLabRestTokenForStep({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).toEqual({
			token: "instance-private-token",
			apiBase: "https://gitlab.example.com/api/v4",
		});
	});
});
