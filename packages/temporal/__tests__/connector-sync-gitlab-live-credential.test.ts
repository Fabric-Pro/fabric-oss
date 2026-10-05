/**
 * A GitLab Data Connection sync acts with the live GitLab connection of the
 * person who started it, resolved inside each activity:
 *
 *   - `loadConnectorConfig` (whose result is recorded in workflow history)
 *     returns no GitLab token from any stored copy;
 *   - the test / discover / fetch activities read the acting person's
 *     `(userId, organizationId)` connection and nobody else's;
 *   - requests go only to the credential's instance, through the guarded
 *     GitLab fetch, without following redirects; a configured address on
 *     another instance (or a refused one) stops the sync before any request.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	createDocumentChunks: vi.fn(),
	db: {},
	getConnectionWithCredentials: vi.fn(),
	getDataConnectionSyncMetadata: vi.fn(),
	getSyncedResourceByExternalId: vi.fn(),
	updateWorkspaceDocument: vi.fn(),
	updateDataConnection: vi.fn(),
	createSyncJob: vi.fn(),
	updateSyncJob: vi.fn(),
	upsertSyncedResource: vi.fn(),
	upsertSyncSchedule: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getSystemRAGProviderConfig: vi.fn(),
}));

vi.mock("@repo/rag", () => ({
	chunkText: vi.fn(),
	deleteWorkspaceDocumentChunks: vi.fn(),
	enrichChunksWithTenantContext: vi.fn(),
	generateEmbeddings: vi.fn(),
	storeWorkspaceChunksBatch: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((value: string) => value),
}));

vi.mock("@repo/integrations/gitlab", async () => ({
	...(await vi.importActual<typeof import("@repo/integrations/gitlab")>(
		"@repo/integrations/gitlab",
	)),
	getGitLabConnectionToken: vi.fn(),
}));

import {
	getConnectionWithCredentials,
	getDataConnectionSyncMetadata,
} from "@repo/database";
import {
	type GitLabConnectionTokenResult,
	getGitLabConnectionToken,
} from "@repo/integrations/gitlab";
import { decryptApiKey } from "@repo/utils";
import { ApplicationFailure } from "@temporalio/common";
import {
	discoverResources,
	fetchResourceDocuments,
	loadConnectorConfig,
	testConnection,
} from "../src/activities/connector-sync";
import {
	GITLAB_SYNC_ACCESS_DENIED,
	GITLAB_SYNC_CONNECTION_REQUIRED,
	GITLAB_SYNC_ORIGIN_MISMATCH,
	GITLAB_SYNC_RESOURCE_FORBIDDEN,
	GITLAB_SYNC_STOP_FAILURE_TYPES,
} from "../src/workflows/connector-sync/types";

const ACTOR = { userId: "user-1", organizationId: "org-1" };

function connected(
	origin: string,
	accessToken = "live-token",
): GitLabConnectionTokenResult {
	return {
		ok: true,
		accessToken,
		issuer: { kind: "app", clientId: "client-1", origin },
		origin,
		integrationId: "wi-1",
		generation: 3,
		settings: {},
	};
}

/** Each person's own connection; nobody else's is ever returned. */
function connectionsByPerson(
	byUser: Record<string, GitLabConnectionTokenResult>,
) {
	vi.mocked(getGitLabConnectionToken).mockImplementation(
		async (tenant) =>
			byUser[`${tenant.userId}|${tenant.organizationId}`] ?? {
				ok: false,
				reason: "not-connected",
				message: "GitLab is not connected",
			},
	);
}

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: async () => body } as Response;
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected a failure");
}

beforeEach(() => {
	vi.clearAllMocks();
	global.fetch = vi.fn();
});

describe("loadConnectorConfig — GitLab", () => {
	it("reads metadata only and returns no token material from any stored copy", async () => {
		vi.mocked(getDataConnectionSyncMetadata).mockResolvedValueOnce({
			id: "conn-gl",
			provider: "GITLAB",
			name: "GitLab",
			status: "CONNECTED",
			config: {
				baseUrl: "https://gitlab.example.com",
				projects: ["a/b"],
			},
			lastSyncAt: null,
		} as any);
		// What the credential-bearing read would return for the same row.
		vi.mocked(getConnectionWithCredentials).mockResolvedValue({
			id: "conn-gl",
			provider: "GITLAB",
			name: "GitLab",
			status: "CONNECTED",
			accessToken: "copied-access-token",
			refreshToken: "copied-refresh-token",
			tokenExpiresAt: null,
			credentials: {
				access_token: "inline-access-token",
				apiKey: "inline-api-key",
			},
			credentialId: "cred-1",
			credential: {
				id: "cred-1",
				name: "GitLab PAT",
				credentialType: "apiKey",
				encryptedPayload: '{"apiKey":"saved-credential-token"}',
			},
			config: {
				baseUrl: "https://gitlab.example.com",
				projects: ["a/b"],
			},
			lastSyncAt: null,
			userId: null,
			organizationId: "org-1",
		} as any);

		const result = await loadConnectorConfig({
			connectorId: "conn-gl",
			...ACTOR,
		});

		expect(result?.credentials).toEqual({});
		expect(result?.providerConfig).toEqual({
			baseUrl: "https://gitlab.example.com",
			projects: ["a/b"],
		});
		const serialized = JSON.stringify(result);
		for (const secret of [
			"copied-access-token",
			"copied-refresh-token",
			"inline-access-token",
			"inline-api-key",
			"saved-credential-token",
		]) {
			expect(serialized).not.toContain(secret);
		}
		// The credential-bearing read is not made, and nothing is decrypted.
		expect(getConnectionWithCredentials).not.toHaveBeenCalled();
		expect(decryptApiKey).not.toHaveBeenCalled();
	});

	it("still merges stored credentials for other providers", async () => {
		vi.mocked(getDataConnectionSyncMetadata).mockResolvedValueOnce({
			id: "conn-gh",
			provider: "GITHUB",
			name: "GitHub",
			status: "CONNECTED",
			config: {},
			lastSyncAt: null,
		} as any);
		vi.mocked(getConnectionWithCredentials).mockResolvedValueOnce({
			id: "conn-gh",
			provider: "GITHUB",
			name: "GitHub",
			status: "CONNECTED",
			accessToken: "gh-access",
			refreshToken: null,
			tokenExpiresAt: null,
			credentials: { apiKey: "gh-inline" },
			credentialId: null,
			credential: null,
			config: {},
			lastSyncAt: null,
			userId: null,
			organizationId: "org-1",
		} as any);

		const result = await loadConnectorConfig({
			connectorId: "conn-gh",
			...ACTOR,
		});

		expect(result?.credentials).toMatchObject({
			accessToken: "gh-access",
			apiKey: "gh-inline",
		});
	});
});

describe("GitLab activities act with the acting person's own connection", () => {
	it("testConnection reads the acting person's connection and ignores any passed token", async () => {
		connectionsByPerson({
			"user-1|org-1": connected("https://gitlab.com"),
		});
		vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ id: 1 }));

		const ok = await testConnection({
			connectorId: "conn-gl",
			provider: "GITLAB",
			credentials: { accessToken: "stale-copy" },
			...ACTOR,
		});

		expect(ok).toBe(true);
		expect(getGitLabConnectionToken).toHaveBeenCalledWith(
			{ userId: "user-1", organizationId: "org-1" },
			{ anyOrigin: true, mode: "strict" },
		);
		const [url, init] = vi.mocked(global.fetch).mock.calls[0]!;
		expect(url).toBe("https://gitlab.com/api/v4/user");
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer live-token",
		);
		expect(init?.redirect).toBe("error");
	});

	it("never uses another member's connection", async () => {
		// Only user-2 is connected in this organization.
		connectionsByPerson({
			"user-2|org-1": connected("https://gitlab.com", "teammate-token"),
		});

		const error = await failureOf(
			testConnection({
				connectorId: "conn-gl",
				provider: "GITLAB",
				credentials: {},
				...ACTOR,
			}),
		);

		expect(error).toBeInstanceOf(ApplicationFailure);
		expect((error as ApplicationFailure).type).toBe(
			GITLAB_SYNC_CONNECTION_REQUIRED,
		);
		expect((error as ApplicationFailure).nonRetryable).toBe(true);
		expect((error as Error).message).toContain(
			"Connect your GitLab account",
		);
		expect(
			vi
				.mocked(getGitLabConnectionToken)
				.mock.calls.map(([tenant]) => tenant),
		).toEqual([{ userId: "user-1", organizationId: "org-1" }]);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("asks for a reconnect when the connection needs one", async () => {
		vi.mocked(getGitLabConnectionToken).mockResolvedValue({
			ok: false,
			reason: "needs-reauth",
			message: "the GitLab connection needs to be reconnected",
		});

		const error = await failureOf(
			discoverResources({
				connectorId: "conn-gl",
				provider: "GITLAB",
				providerConfig: {},
				credentials: {},
				...ACTOR,
			}),
		);

		expect((error as ApplicationFailure).type).toBe(
			GITLAB_SYNC_CONNECTION_REQUIRED,
		);
		expect((error as Error).message).toContain("needs to be reconnected");
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("refuses a run with no acting person without reading any connection", async () => {
		const error = await failureOf(
			fetchResourceDocuments({
				connectorId: "conn-gl",
				provider: "GITLAB",
				resource: { id: "a/b", name: "a/b", type: "gitlab-project" },
				credentials: { accessToken: "stale-copy" },
				syncType: "full",
				batchSize: 10,
			}),
		);

		expect((error as ApplicationFailure).type).toBe(
			GITLAB_SYNC_CONNECTION_REQUIRED,
		);
		expect(getGitLabConnectionToken).not.toHaveBeenCalled();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("lets a transient token failure retry", async () => {
		vi.mocked(getGitLabConnectionToken).mockResolvedValue({
			ok: false,
			reason: "transient",
			message: "temporarily unavailable",
		});

		const error = await failureOf(
			discoverResources({
				connectorId: "conn-gl",
				provider: "GITLAB",
				providerConfig: {},
				credentials: {},
				...ACTOR,
			}),
		);

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ApplicationFailure);
	});
});

describe("GitLab requests go only to the credential's instance", () => {
	it("refuses a configured address on another instance before any request", async () => {
		connectionsByPerson({
			"user-1|org-1": connected("https://gitlab.com"),
		});

		const error = await failureOf(
			discoverResources({
				connectorId: "conn-gl",
				provider: "GITLAB",
				providerConfig: {
					baseUrl: "https://gitlab.example.com/api/v4",
				},
				credentials: {},
				...ACTOR,
			}),
		);

		expect((error as ApplicationFailure).type).toBe(
			GITLAB_SYNC_ORIGIN_MISMATCH,
		);
		expect((error as ApplicationFailure).nonRetryable).toBe(true);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("refuses a private configured address before reading the connection", async () => {
		connectionsByPerson({
			"user-1|org-1": connected("https://gitlab.com"),
		});

		const error = await failureOf(
			discoverResources({
				connectorId: "conn-gl",
				provider: "GITLAB",
				providerConfig: { baseUrl: "https://10.0.0.5/api/v4" },
				credentials: {},
				...ACTOR,
			}),
		);

		expect((error as ApplicationFailure).type).toBe(
			GITLAB_SYNC_ORIGIN_MISMATCH,
		);
		expect(getGitLabConnectionToken).not.toHaveBeenCalled();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("refuses a resource recorded on another instance (a stale discovery)", async () => {
		connectionsByPerson({
			"user-1|org-1": connected("https://gitlab.example.com"),
		});

		const error = await failureOf(
			fetchResourceDocuments({
				connectorId: "conn-gl",
				provider: "GITLAB",
				resource: {
					id: "a/b",
					name: "a/b",
					type: "gitlab-project",
					metadata: {
						fullPath: "a/b",
						baseUrl: "https://gitlab.com/api/v4",
					},
				},
				credentials: {},
				syncType: "full",
				batchSize: 10,
				...ACTOR,
			}),
		);

		expect((error as ApplicationFailure).type).toBe(
			GITLAB_SYNC_ORIGIN_MISMATCH,
		);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("sends a self-hosted credential to its own instance, without following redirects", async () => {
		connectionsByPerson({
			"user-1|org-1": connected("https://gitlab.example.com"),
		});
		vi.mocked(global.fetch)
			.mockResolvedValueOnce(jsonResponse([]))
			.mockResolvedValueOnce(jsonResponse([]));

		await fetchResourceDocuments({
			connectorId: "conn-gl",
			provider: "GITLAB",
			resource: {
				id: "a/b",
				name: "a/b",
				type: "gitlab-project",
				metadata: {
					fullPath: "a/b",
					baseUrl: "https://gitlab.example.com/api/v4",
				},
			},
			credentials: {},
			providerConfig: {},
			syncType: "full",
			batchSize: 10,
			...ACTOR,
		});

		const calls = vi.mocked(global.fetch).mock.calls;
		expect(calls.map(([url]) => String(url))).toEqual([
			"https://gitlab.example.com/api/v4/projects/a%2Fb/issues?state=all&per_page=10",
			"https://gitlab.example.com/api/v4/projects/a%2Fb/merge_requests?state=all&per_page=10",
		]);
		for (const [, init] of calls) {
			expect(init?.redirect).toBe("error");
		}
	});

	it("discovers on the credential's instance when no address is configured", async () => {
		connectionsByPerson({
			"user-1|org-1": connected("https://gitlab.example.com"),
		});
		vi.mocked(global.fetch).mockResolvedValueOnce(
			jsonResponse([
				{
					id: 7,
					name: "b",
					web_url: "https://gitlab.example.com/a/b",
					path_with_namespace: "a/b",
				},
			]),
		);

		const resources = await discoverResources({
			connectorId: "conn-gl",
			provider: "GITLAB",
			providerConfig: {},
			credentials: {},
			...ACTOR,
		});

		expect(String(vi.mocked(global.fetch).mock.calls[0]![0])).toMatch(
			/^https:\/\/gitlab\.example\.com\/api\/v4\/projects\?/,
		);
		expect(resources[0]?.metadata).toMatchObject({
			fullPath: "a/b",
			baseUrl: "https://gitlab.example.com/api/v4",
		});
	});

	it("goes through the guarded fetch: a credential on a private address never reaches the network", async () => {
		// The connection service refuses such an origin itself; this proves the
		// request path does too, independently.
		connectionsByPerson({ "user-1|org-1": connected("https://127.0.0.1") });

		await expect(
			testConnection({
				connectorId: "conn-gl",
				provider: "GITLAB",
				credentials: {},
				...ACTOR,
			}),
		).rejects.toThrow();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("authenticates against a sub-path install's configured base", async () => {
		connectionsByPerson({
			"user-1|org-1": connected("https://gitlab.example.com"),
		});
		vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ id: 1 }));

		await expect(
			testConnection({
				connectorId: "conn-gl",
				provider: "GITLAB",
				credentials: {},
				providerConfig: {
					baseUrl: "https://gitlab.example.com/gitlab",
				},
				...ACTOR,
			}),
		).resolves.toBe(true);

		expect(String(vi.mocked(global.fetch).mock.calls[0]?.[0])).toBe(
			"https://gitlab.example.com/gitlab/api/v4/user",
		);
	});
});

function statusResponse(status: number): Response {
	return { ok: false, status, json: async () => ({}) } as Response;
}

const RESOURCE = {
	id: "a/b",
	name: "a/b",
	type: "gitlab-project",
	metadata: { fullPath: "a/b", baseUrl: "https://gitlab.com/api/v4" },
};

describe("GitLab refusing the credential is a typed failure, never a skippable error", () => {
	beforeEach(() => {
		connectionsByPerson({
			"user-1|org-1": connected("https://gitlab.com"),
		});
	});

	it("a 401 during fetch asks for a reconnect and is not retried", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(statusResponse(401));

		const error = await failureOf(
			fetchResourceDocuments({
				connectorId: "conn-gl",
				provider: "GITLAB",
				resource: RESOURCE,
				credentials: {},
				syncType: "full",
				batchSize: 10,
				...ACTOR,
			}),
		);

		expect(error).toBeInstanceOf(ApplicationFailure);
		expect((error as ApplicationFailure).type).toBe(
			GITLAB_SYNC_CONNECTION_REQUIRED,
		);
		expect((error as ApplicationFailure).nonRetryable).toBe(true);
		expect((error as Error).message).toContain(
			"Reconnect your GitLab account",
		);
	});

	it("a 403 on project discovery stops the sync as an account refusal", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(statusResponse(403));

		const error = await failureOf(
			discoverResources({
				connectorId: "conn-gl",
				provider: "GITLAB",
				providerConfig: {},
				credentials: {},
				...ACTOR,
			}),
		);

		expect((error as ApplicationFailure).type).toBe(
			GITLAB_SYNC_ACCESS_DENIED,
		);
		expect(GITLAB_SYNC_STOP_FAILURE_TYPES).toContain(
			GITLAB_SYNC_ACCESS_DENIED,
		);
	});

	it("a 403 on one project's issues fails only that resource", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(statusResponse(403));

		const error = await failureOf(
			fetchResourceDocuments({
				connectorId: "conn-gl",
				provider: "GITLAB",
				resource: RESOURCE,
				credentials: {},
				syncType: "full",
				batchSize: 10,
				...ACTOR,
			}),
		);

		expect((error as ApplicationFailure).type).toBe(
			GITLAB_SYNC_RESOURCE_FORBIDDEN,
		);
		expect((error as ApplicationFailure).nonRetryable).toBe(true);
		expect(GITLAB_SYNC_STOP_FAILURE_TYPES).not.toContain(
			GITLAB_SYNC_RESOURCE_FORBIDDEN,
		);
	});

	it("testConnection reports a rejected /user with its reason instead of false", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(statusResponse(401));

		const error = await failureOf(
			testConnection({
				connectorId: "conn-gl",
				provider: "GITLAB",
				credentials: {},
				...ACTOR,
			}),
		);

		expect((error as ApplicationFailure).type).toBe(
			GITLAB_SYNC_CONNECTION_REQUIRED,
		);
	});

	it("testConnection reports another GitLab error with its status, retryably", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(statusResponse(502));

		const error = await failureOf(
			testConnection({
				connectorId: "conn-gl",
				provider: "GITLAB",
				credentials: {},
				...ACTOR,
			}),
		);

		expect(error).not.toBeInstanceOf(ApplicationFailure);
		expect((error as Error).message).toBe("GitLab API error 502 for /user");
	});
});
