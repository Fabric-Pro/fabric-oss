import { beforeEach, describe, expect, it, vi } from "vitest";

const mockS3Send = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
	// vitest 4.x rejects arrow-function .mockImplementation here because
	// the source calls `new S3Client(...)` and arrows aren't constructable.
	// Use a real class instead.
	S3Client: class MockS3Client {
		send = mockS3Send;
	},
	ListObjectsV2Command: class ListObjectsV2Command {
		input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	},
	GetObjectCommand: class GetObjectCommand {
		input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	},
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	createDocumentChunks: vi.fn(),
	db: {
		workspaceDocument: {
			create: vi.fn(),
		},
		workspaceDocumentChunk: {
			deleteMany: vi.fn(),
		},
	},
	getConnectionWithCredentials: vi.fn(),
	getSyncedResourceByExternalId: vi.fn(),
	getSyncedResources: vi.fn(),
	updateWorkspaceDocument: vi.fn(),
	updateDataConnection: vi.fn(),
	createSyncJob: vi.fn(),
	updateSyncJob: vi.fn(),
	upsertSyncedResource: vi.fn(),
	upsertSyncSchedule: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getSystemRAGProviderConfig: vi.fn().mockResolvedValue({
		apiKey: "test-key",
		provider: "OPENAI_DIRECT",
	}),
}));

vi.mock("@repo/rag", () => ({
	chunkText: vi.fn((content: string) => [
		{ index: 0, content, metadata: {} },
	]),
	deleteWorkspaceDocumentChunks: vi.fn(),
	enrichChunksWithTenantContext: vi.fn(async (chunks: Array<any>) =>
		chunks.map((chunk) => ({
			...chunk,
			originalContent: chunk.content,
			enrichedContent: chunk.content,
		})),
	),
	generateEmbeddings: vi.fn().mockResolvedValue({
		embeddings: [[0.1, 0.2, 0.3]],
	}),
	storeWorkspaceChunksBatch: vi.fn().mockResolvedValue(["point-1"]),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((value: string) => value),
}));

import { getConnectionWithCredentials } from "@repo/database";
import {
	discoverResources,
	fetchResourceDocuments,
	loadConnectorConfig,
} from "../src/activities/connector-sync";

describe("connector sync GitHub provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockS3Send.mockReset();
		global.fetch = vi.fn();
	});

	it("discovers configured GitHub repositories without API discovery", async () => {
		const resources = await discoverResources({
			connectorId: "conn-1",
			provider: "GITHUB",
			providerConfig: {
				owner: "acme",
				repos: ["acme/api", "acme/web"],
				excludeRepos: ["acme/web"],
			},
			credentials: { accessToken: "gh-token" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "acme/api",
				name: "acme/api",
				type: "github-repository",
			}),
		]);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("discovers GitHub repositories from the authenticated account", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => [
				{
					full_name: "acme/api",
					html_url: "https://github.com/acme/api",
					owner: { login: "acme" },
					name: "api",
				},
				{
					full_name: "other/repo",
					html_url: "https://github.com/other/repo",
					owner: { login: "other" },
					name: "repo",
				},
			],
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-1",
			provider: "GITHUB",
			providerConfig: {
				owner: "acme",
			},
			credentials: { accessToken: "gh-token" },
		});

		expect(resources).toHaveLength(1);
		expect(resources[0]).toEqual(
			expect.objectContaining({
				id: "acme/api",
				path: "https://github.com/acme/api",
			}),
		);
	});

	it("fetches GitHub issues and pull requests as searchable documents", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => [
				{
					number: 12,
					title: "Fix auth token expiry",
					body: "We should refresh tokens before they expire.",
					html_url: "https://github.com/acme/api/issues/12",
					user: { login: "test-user" },
					created_at: "2026-04-01T12:00:00Z",
					updated_at: "2026-04-03T12:00:00Z",
					state: "open",
					labels: [{ name: "bug" }],
				},
				{
					number: 41,
					title: "Improve connector sync",
					body: "Adds incremental sync support.",
					html_url: "https://github.com/acme/api/pull/41",
					user: { login: "fabric-bot" },
					created_at: "2026-04-02T12:00:00Z",
					updated_at: "2026-04-03T14:00:00Z",
					state: "open",
					pull_request: {},
				},
			],
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-1",
			provider: "GITHUB",
			resource: {
				id: "acme/api",
				name: "acme/api",
				type: "github-repository",
				metadata: { fullName: "acme/api" },
			},
			credentials: { accessToken: "gh-token" },
			providerConfig: {
				includeIssues: true,
				includePullRequests: true,
			},
			syncType: "incremental",
			cursor: {
				connectorId: "conn-1",
				provider: "GITHUB",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(2);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "acme/api:issue:12",
				title: "Issue #12: Fix auth token expiry",
			}),
		);
		expect(result.documents[1]).toEqual(
			expect.objectContaining({
				externalId: "acme/api:pull_request:41",
				title: "PR #41: Improve connector sync",
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T14:00:00Z");
	});
});

describe("connector sync credential loading", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("merges reusable credential payload into connector config", async () => {
		vi.mocked(getConnectionWithCredentials).mockResolvedValueOnce({
			id: "conn-1",
			provider: "CLICKUP",
			name: "ClickUp Search",
			status: "CONNECTED",
			accessToken: null,
			refreshToken: null,
			tokenExpiresAt: null,
			credentials: null,
			credentialId: "cred-1",
			credential: {
				id: "cred-1",
				name: "ClickUp PAT",
				credentialType: "apiKey",
				encryptedPayload: '{"apiKey":"pk_test"}',
			},
			config: {
				teamId: "123",
			},
			lastSyncAt: null,
			userId: "user-1",
			organizationId: null,
		} as any);

		const result = await loadConnectorConfig({
			connectorId: "conn-1",
			userId: "user-1",
		});

		expect(result?.credentials.apiKey).toBe("pk_test");
		expect(result?.providerConfig.teamId).toBe("123");
	});
});

describe("connector sync GitLab provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers configured GitLab projects without API discovery", async () => {
		const resources = await discoverResources({
			connectorId: "conn-gitlab-1",
			provider: "GITLAB",
			providerConfig: {
				baseUrl: "https://gitlab.example.com/api/v4",
				projects: ["platform/api", "platform/web"],
			},
			credentials: { apiKey: "glpat-test" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "platform/api",
				name: "platform/api",
				type: "gitlab-project",
			}),
			expect.objectContaining({
				id: "platform/web",
				name: "platform/web",
				type: "gitlab-project",
			}),
		]);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("fetches GitLab issues and merge requests as searchable documents", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => [
					{
						iid: 14,
						title: "Stabilize sync cursor handling",
						description:
							"Incremental sync should only advance on success.",
						web_url: "https://gitlab.com/platform/api/-/issues/14",
						author: { username: "test-user" },
						created_at: "2026-04-01T12:00:00Z",
						updated_at: "2026-04-03T12:00:00Z",
						state: "opened",
						labels: ["backend"],
					},
				],
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => [
					{
						iid: 27,
						title: "Refactor connector providers",
						description:
							"Moves provider logic into extracted modules.",
						web_url:
							"https://gitlab.com/platform/api/-/merge_requests/27",
						author: { username: "fabric-bot" },
						created_at: "2026-04-02T12:00:00Z",
						updated_at: "2026-04-03T14:00:00Z",
						state: "opened",
						labels: ["refactor"],
					},
				],
			} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-gitlab-1",
			provider: "GITLAB",
			resource: {
				id: "platform/api",
				name: "platform/api",
				type: "gitlab-project",
				metadata: {
					fullPath: "platform/api",
					baseUrl: "https://gitlab.com/api/v4",
				},
			},
			credentials: { apiKey: "glpat-test" },
			providerConfig: {
				includeIssues: true,
				includeMergeRequests: true,
			},
			syncType: "incremental",
			cursor: {
				connectorId: "conn-gitlab-1",
				provider: "GITLAB",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(2);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "platform/api:issue:14",
				title: "Issue #14: Stabilize sync cursor handling",
			}),
		);
		expect(result.documents[1]).toEqual(
			expect.objectContaining({
				externalId: "platform/api:merge_request:27",
				title: "MR #27: Refactor connector providers",
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T14:00:00Z");
	});
});

describe("connector sync Bitbucket provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers configured Bitbucket repositories without API discovery", async () => {
		const resources = await discoverResources({
			connectorId: "conn-bitbucket-1",
			provider: "BITBUCKET",
			providerConfig: {
				username: "test-user",
				repositories: ["acme/api", "acme/web"],
			},
			credentials: { apiKey: "atbb-test" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "acme/api",
				type: "bitbucket-repository",
			}),
			expect.objectContaining({
				id: "acme/web",
				type: "bitbucket-repository",
			}),
		]);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("fetches Bitbucket issues and pull requests as searchable documents", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					values: [
						{
							id: 18,
							title: "Fix stale sync cursor",
							content: {
								raw: "Cursor should only advance when the fetch succeeds.",
							},
							links: {
								html: {
									href: "https://bitbucket.org/acme/api/issues/18",
								},
							},
							reporter: { display_name: "Test User" },
							created_on: "2026-04-01T12:00:00Z",
							updated_on: "2026-04-03T12:00:00Z",
							state: "new",
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					values: [
						{
							id: 52,
							title: "Refactor provider dispatch",
							content: {
								raw: "Moves remaining provider logic into modules.",
							},
							links: {
								html: {
									href: "https://bitbucket.org/acme/api/pull-requests/52",
								},
							},
							author: { display_name: "Fabric Bot" },
							created_on: "2026-04-02T12:00:00Z",
							updated_on: "2026-04-03T14:00:00Z",
							state: "OPEN",
						},
					],
				}),
			} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-bitbucket-1",
			provider: "BITBUCKET",
			resource: {
				id: "acme/api",
				name: "acme/api",
				type: "bitbucket-repository",
				metadata: {
					fullName: "acme/api",
					baseUrl: "https://api.bitbucket.org/2.0",
				},
			},
			credentials: { apiKey: "atbb-test" },
			providerConfig: {
				username: "test-user",
				includeIssues: true,
				includePullRequests: true,
			},
			syncType: "incremental",
			cursor: {
				connectorId: "conn-bitbucket-1",
				provider: "BITBUCKET",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(2);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "acme/api:issue:18",
				title: "Issue #18: Fix stale sync cursor",
			}),
		);
		expect(result.documents[1]).toEqual(
			expect.objectContaining({
				externalId: "acme/api:pull_request:52",
				title: "PR #52: Refactor provider dispatch",
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T14:00:00Z");
	});
});

describe("connector sync S3 provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockS3Send.mockReset();
		global.fetch = vi.fn();
	});

	it("discovers S3 objects from a configured bucket and prefix", async () => {
		mockS3Send.mockResolvedValueOnce({
			Contents: [
				{
					Key: "Product/PRD.md",
					ETag: '"etag-1"',
					LastModified: new Date("2026-04-03T10:00:00Z"),
					Size: 2048,
					StorageClass: "STANDARD",
				},
				{
					Key: "Product/",
				},
			],
			IsTruncated: false,
		});

		const resources = await discoverResources({
			connectorId: "conn-s3-1",
			provider: "S3",
			providerConfig: {
				bucket: "fabric-knowledge",
				prefix: "Product/",
				region: "us-east-1",
			},
			credentials: {
				apiKey: "secret-access-key",
				providerConfig: {
					bucket: "fabric-knowledge",
					prefix: "Product/",
					region: "us-east-1",
					accessKeyId: "AKIA_TEST",
				},
			},
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "s3:fabric-knowledge:Product/PRD.md",
				name: "PRD.md",
				type: "s3-object",
				path: "s3://fabric-knowledge/Product/PRD.md",
				metadata: expect.objectContaining({
					bucket: "fabric-knowledge",
					key: "Product/PRD.md",
				}),
			}),
		]);
	});

	it("fetches S3 object text as a searchable document", async () => {
		mockS3Send.mockResolvedValueOnce({
			Body: {
				transformToString: async () =>
					"# PRD\n\nShip the S3 connector safely.",
			},
		});

		const result = await fetchResourceDocuments({
			connectorId: "conn-s3-1",
			provider: "S3",
			resource: {
				id: "s3:fabric-knowledge:Product/PRD.md",
				name: "PRD.md",
				type: "s3-object",
				path: "s3://fabric-knowledge/Product/PRD.md",
				metadata: {
					bucket: "fabric-knowledge",
					key: "Product/PRD.md",
					eTag: '"etag-1"',
					lastModified: "2026-04-03T10:00:00Z",
					size: 2048,
					storageClass: "STANDARD",
				},
			},
			credentials: {
				apiKey: "secret-access-key",
				providerConfig: {
					bucket: "fabric-knowledge",
					region: "us-east-1",
					accessKeyId: "AKIA_TEST",
				},
			},
			syncType: "incremental",
			cursor: {
				connectorId: "conn-s3-1",
				provider: "S3",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "s3:object:fabric-knowledge:Product/PRD.md",
				title: "PRD.md",
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T10:00:00Z");
	});
});

describe("connector sync Google Storage provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockS3Send.mockReset();
		global.fetch = vi.fn();
	});

	it("discovers Google Storage objects from a configured bucket and prefix", async () => {
		mockS3Send.mockResolvedValueOnce({
			Contents: [
				{
					Key: "Product/spec.md",
					ETag: '"etag-gcs-1"',
					LastModified: new Date("2026-04-03T10:30:00Z"),
					Size: 1024,
					StorageClass: "STANDARD",
				},
			],
			IsTruncated: false,
		});

		const resources = await discoverResources({
			connectorId: "conn-gcs-1",
			provider: "GOOGLE_STORAGE",
			providerConfig: {
				bucket: "fabric-gcs",
				prefix: "Product/",
				region: "auto",
				endpoint: "https://storage.googleapis.com",
				accessKeyId: "GOOG1EXAMPLE",
				forcePathStyle: true,
			},
			credentials: {
				apiKey: "gcs-secret-key",
			},
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "google_storage:fabric-gcs:Product/spec.md",
				name: "spec.md",
				type: "google-storage-object",
				path: "gs://fabric-gcs/Product/spec.md",
			}),
		]);
	});

	it("fetches Google Storage object text as a searchable document", async () => {
		mockS3Send.mockResolvedValueOnce({
			Body: {
				transformToString: async () =>
					"# Spec\n\nShip the Google Storage connector safely.",
			},
		});

		const result = await fetchResourceDocuments({
			connectorId: "conn-gcs-1",
			provider: "GOOGLE_STORAGE",
			resource: {
				id: "google_storage:fabric-gcs:Product/spec.md",
				name: "spec.md",
				type: "google-storage-object",
				path: "gs://fabric-gcs/Product/spec.md",
				metadata: {
					bucket: "fabric-gcs",
					key: "Product/spec.md",
					eTag: '"etag-gcs-1"',
					lastModified: "2026-04-03T10:30:00Z",
					size: 1024,
					storageClass: "STANDARD",
				},
			},
			credentials: {
				apiKey: "gcs-secret-key",
				providerConfig: {
					bucket: "fabric-gcs",
					region: "auto",
					endpoint: "https://storage.googleapis.com",
					accessKeyId: "GOOG1EXAMPLE",
					forcePathStyle: true,
				},
			},
			syncType: "incremental",
			cursor: {
				connectorId: "conn-gcs-1",
				provider: "GOOGLE_STORAGE",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "google-storage:object:fabric-gcs:Product/spec.md",
				title: "spec.md",
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T10:30:00Z");
	});
});

describe("connector sync R2 provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockS3Send.mockReset();
		global.fetch = vi.fn();
	});

	it("discovers R2 objects from a configured bucket and prefix", async () => {
		mockS3Send.mockResolvedValueOnce({
			Contents: [
				{
					Key: "Knowledge/runbook.md",
					ETag: '"etag-r2-1"',
					LastModified: new Date("2026-04-03T11:00:00Z"),
					Size: 1536,
					StorageClass: "STANDARD",
				},
			],
			IsTruncated: false,
		});

		const resources = await discoverResources({
			connectorId: "conn-r2-1",
			provider: "R2",
			providerConfig: {
				bucket: "fabric-r2",
				prefix: "Knowledge/",
				region: "auto",
				endpoint: "https://account-id.r2.cloudflarestorage.com",
				accessKeyId: "R2ACCESSKEY",
				forcePathStyle: false,
			},
			credentials: {
				apiKey: "r2-secret-key",
			},
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "r2:fabric-r2:Knowledge/runbook.md",
				name: "runbook.md",
				type: "r2-object",
				path: "r2://fabric-r2/Knowledge/runbook.md",
			}),
		]);
	});

	it("fetches R2 object text as a searchable document", async () => {
		mockS3Send.mockResolvedValueOnce({
			Body: {
				transformToString: async () =>
					"# Runbook\n\nShip the R2 connector safely.",
			},
		});

		const result = await fetchResourceDocuments({
			connectorId: "conn-r2-1",
			provider: "R2",
			resource: {
				id: "r2:fabric-r2:Knowledge/runbook.md",
				name: "runbook.md",
				type: "r2-object",
				path: "r2://fabric-r2/Knowledge/runbook.md",
				metadata: {
					bucket: "fabric-r2",
					key: "Knowledge/runbook.md",
					eTag: '"etag-r2-1"',
					lastModified: "2026-04-03T11:00:00Z",
					size: 1536,
					storageClass: "STANDARD",
				},
			},
			credentials: {
				apiKey: "r2-secret-key",
				providerConfig: {
					bucket: "fabric-r2",
					region: "auto",
					endpoint: "https://account-id.r2.cloudflarestorage.com",
					accessKeyId: "R2ACCESSKEY",
					forcePathStyle: false,
				},
			},
			syncType: "incremental",
			cursor: {
				connectorId: "conn-r2-1",
				provider: "R2",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "r2:object:fabric-r2:Knowledge/runbook.md",
				title: "runbook.md",
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T11:00:00Z");
	});
});

describe("connector sync Dropbox provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockS3Send.mockReset();
		global.fetch = vi.fn();
	});

	it("discovers Dropbox files from configured paths", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				entries: [
					{
						".tag": "file",
						id: "id:dropbox-1",
						name: "PRD.md",
						path_lower: "/product/prd.md",
						path_display: "/Product/PRD.md",
						server_modified: "2026-04-03T10:00:00Z",
						size: 2048,
						is_downloadable: true,
					},
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-dropbox-1",
			provider: "DROPBOX",
			providerConfig: {
				paths: ["/Product"],
			},
			credentials: { apiKey: "dropbox-token" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "id:dropbox-1",
				name: "PRD.md",
				type: "dropbox-file",
				metadata: expect.objectContaining({
					pathLower: "/product/prd.md",
				}),
			}),
		]);
	});

	it("fetches Dropbox file content as a searchable document", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			text: async () => "# PRD\n\nShip connector sync safely.",
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-dropbox-1",
			provider: "DROPBOX",
			resource: {
				id: "id:dropbox-1",
				name: "PRD.md",
				type: "dropbox-file",
				metadata: {
					pathLower: "/product/prd.md",
					pathDisplay: "/Product/PRD.md",
					serverModified: "2026-04-03T10:00:00Z",
					size: 2048,
					isDownloadable: true,
				},
			},
			credentials: { apiKey: "dropbox-token" },
			syncType: "incremental",
			cursor: {
				connectorId: "conn-dropbox-1",
				provider: "DROPBOX",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "dropbox:file:id:dropbox-1",
				title: "PRD.md",
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T10:00:00Z");
	});
});

describe("connector sync Airtable provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockS3Send.mockReset();
		global.fetch = vi.fn();
	});

	it("discovers Airtable tables from base metadata", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				tables: [
					{
						id: "tblAuth",
						name: "Authentication",
						description: "Core auth requirements",
						fields: [
							{
								id: "fldName",
								name: "Name",
								type: "singleLineText",
							},
							{
								id: "fldStatus",
								name: "Status",
								type: "singleSelect",
							},
						],
					},
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-airtable-1",
			provider: "AIRTABLE",
			providerConfig: {
				baseId: "app123",
			},
			credentials: { apiKey: "pat-airtable" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "airtable:table:app123:tblAuth",
				name: "Authentication",
				type: "airtable-table",
				metadata: expect.objectContaining({
					baseId: "app123",
					tableId: "tblAuth",
				}),
			}),
		]);
	});

	it("fetches Airtable table records as a searchable document", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				records: [
					{
						id: "rec1",
						createdTime: "2026-04-03T10:00:00Z",
						fields: {
							Name: "Use SSO",
							Status: "Planned",
						},
					},
					{
						id: "rec2",
						createdTime: "2026-04-03T11:00:00Z",
						fields: {
							Name: "Rotate secrets",
							Status: "In Progress",
						},
					},
				],
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-airtable-1",
			provider: "AIRTABLE",
			resource: {
				id: "airtable:table:app123:tblAuth",
				name: "Authentication",
				type: "airtable-table",
				path: "https://airtable.com/app123/tblAuth",
				metadata: {
					baseId: "app123",
					tableId: "tblAuth",
				},
			},
			credentials: { apiKey: "pat-airtable" },
			providerConfig: {
				baseId: "app123",
				view: "Grid view",
				maxRecordsPerTable: 50,
			},
			syncType: "incremental",
			cursor: {
				connectorId: "conn-airtable-1",
				provider: "AIRTABLE",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "airtable:table:app123:tblAuth",
				title: "Authentication",
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T11:00:00Z");
	});
});

describe("connector sync Coda provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Coda pages from docs and page listings", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					items: [
						{
							id: "AbCDeF",
							name: "Product Spec",
							browserLink: "https://coda.io/d/_dAbCDeF",
							workspace: { id: "ws-1", name: "Example Corp" },
							updatedAt: "2026-04-03T10:00:00Z",
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					items: [
						{
							id: "page-1",
							name: "Authentication",
							browserLink: "https://coda.io/d/_dAbCDeF/page-1",
							contentType: "canvas",
							updatedAt: "2026-04-03T11:00:00Z",
							isHidden: false,
						},
					],
				}),
			} as Response);

		const resources = await discoverResources({
			connectorId: "conn-coda-1",
			provider: "CODA",
			providerConfig: {
				workspaceId: "ws-1",
				includePages: true,
			},
			credentials: { apiKey: "coda-token" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "coda-page:AbCDeF:page-1",
				type: "coda-page",
				metadata: expect.objectContaining({
					docId: "AbCDeF",
					pageId: "page-1",
				}),
			}),
		]);
	});

	it("fetches Coda page content as a searchable document", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				items: [
					{
						itemContent: {
							content: "Use SSO for employee access.",
						},
					},
					{
						itemContent: {
							content: "Rotate secrets every 90 days.",
						},
					},
				],
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-coda-1",
			provider: "CODA",
			resource: {
				id: "coda-page:AbCDeF:page-1",
				name: "Product Spec / Authentication",
				type: "coda-page",
				path: "https://coda.io/d/_dAbCDeF/page-1",
				metadata: {
					docId: "AbCDeF",
					docName: "Product Spec",
					pageId: "page-1",
					updatedAt: "2026-04-03T11:00:00Z",
				},
			},
			credentials: { apiKey: "coda-token" },
			syncType: "incremental",
			cursor: {
				connectorId: "conn-coda-1",
				provider: "CODA",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "coda:page:AbCDeF:page-1",
				title: "Product Spec / Authentication",
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T11:00:00Z");
	});
});

describe("connector sync GitBook provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers GitBook pages from a space", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				pages: [
					{
						id: "page-1",
						title: "Authentication",
						path: "/auth",
						type: "document",
						kind: "page",
						updatedAt: "2026-04-03T11:00:00Z",
						urls: { app: "https://app.gitbook.com/s/space/auth" },
					},
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-gitbook-1",
			provider: "GITBOOK",
			providerConfig: {
				spaceId: "space-123",
			},
			credentials: { apiKey: "gitbook-token" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "gitbook-page:space-123:page-1",
				type: "gitbook-page",
				metadata: expect.objectContaining({
					spaceId: "space-123",
					pageId: "page-1",
				}),
			}),
		]);
	});

	it("fetches GitBook page content as a searchable document", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				document: {
					nodes: [
						{
							type: "heading-1",
							nodes: [{ leaves: [{ text: "Authentication" }] }],
						},
						{
							type: "paragraph",
							nodes: [
								{
									leaves: [
										{
											text: "Use SSO for employee access.",
										},
									],
								},
							],
						},
					],
				},
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-gitbook-1",
			provider: "GITBOOK",
			resource: {
				id: "gitbook-page:space-123:page-1",
				name: "Authentication",
				type: "gitbook-page",
				path: "https://app.gitbook.com/s/space/auth",
				metadata: {
					spaceId: "space-123",
					pageId: "page-1",
					path: "/auth",
					updatedAt: "2026-04-03T11:00:00Z",
				},
			},
			credentials: { apiKey: "gitbook-token" },
			syncType: "incremental",
			cursor: {
				connectorId: "conn-gitbook-1",
				provider: "GITBOOK",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "gitbook:page:space-123:page-1",
				title: "Authentication",
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T11:00:00Z");
	});
});

describe("connector sync Confluence provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Confluence pages from search results", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [
					{
						id: "12345",
						title: "Engineering Handbook",
						_links: { webui: "/wiki/spaces/ENG/pages/12345" },
						space: { key: "ENG", name: "Engineering" },
					},
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-2",
			provider: "CONFLUENCE",
			providerConfig: {
				spaceKeys: ["ENG"],
			},
			credentials: {
				domain: "example.atlassian.net",
				email: "test-user@example.com",
				apiToken: "token-123",
			},
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "12345",
				name: "Engineering Handbook",
				type: "confluence-page",
				metadata: expect.objectContaining({
					spaceKey: "ENG",
				}),
			}),
		]);
		expect(global.fetch).toHaveBeenCalledWith(
			expect.stringContaining(
				"https://example.atlassian.net/wiki/rest/api/content/search?",
			),
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: expect.stringMatching(/^Basic /),
				}),
			}),
		);
	});

	it("fetches and normalizes Confluence page content as searchable documents", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				id: "12345",
				title: "Engineering Handbook",
				body: {
					storage: {
						value: "<h1>Authentication</h1><p>Use <strong>SSO</strong> for access.</p><ul><li>Rotate secrets</li></ul>",
					},
				},
				version: {
					when: "2026-04-03T10:00:00Z",
					number: 7,
				},
				space: { key: "ENG", name: "Engineering" },
				_links: { webui: "/wiki/spaces/ENG/pages/12345" },
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-2",
			provider: "CONFLUENCE",
			resource: {
				id: "12345",
				name: "Engineering Handbook",
				type: "confluence-page",
				metadata: { pageId: "12345" },
			},
			credentials: {
				domain: "example.atlassian.net",
				email: "test-user@example.com",
				apiToken: "token-123",
			},
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "confluence:page:12345",
				title: "Engineering Handbook",
				content: expect.stringContaining("Use **SSO** for access."),
				metadata: expect.objectContaining({
					spaceKey: "ENG",
					version: 7,
				}),
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T10:00:00Z");
	});
});

describe("connector sync Slack provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Slack channels using the generic connector path", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				ok: true,
				channels: [
					{ id: "C123", name: "engineering", is_private: false },
					{ id: "C999", name: "random", is_private: false },
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-3",
			provider: "SLACK",
			providerConfig: {
				channelIds: ["C123"],
				includePublicChannels: true,
				includePrivateChannels: false,
			},
			credentials: { accessToken: "xoxp-token" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "C123",
				name: "engineering",
				type: "slack-channel",
			}),
		]);
	});

	it("fetches Slack messages and thread replies as searchable documents", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					messages: [
						{
							ts: "1712145600.000100",
							text: "Auth rollout is ready",
							user: "U123",
							thread_ts: "1712145600.000100",
							reply_count: 1,
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					messages: [
						{
							ts: "1712145600.000100",
							text: "Auth rollout is ready",
							user: "U123",
						},
						{
							ts: "1712149200.000200",
							text: "Remember to update the PRD",
							user: "U456",
						},
					],
				}),
			} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-3",
			provider: "SLACK",
			resource: {
				id: "C123",
				name: "engineering",
				type: "slack-channel",
				metadata: {
					channelId: "C123",
					channelName: "engineering",
					isPrivate: false,
				},
			},
			credentials: { accessToken: "xoxp-token" },
			providerConfig: {
				includeThreads: true,
			},
			syncType: "incremental",
			cursor: {
				connectorId: "conn-3",
				provider: "SLACK",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "slack:C123:1712145600.000100",
				title: "#engineering message",
				content: expect.stringContaining("Remember to update the PRD"),
				metadata: expect.objectContaining({
					channelName: "engineering",
					replyCount: 1,
				}),
			}),
		);
		expect(result.newCursor?.provider).toBe("SLACK");
	});
});

describe("connector sync Notion provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Notion pages from the generic search API", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [
					{
						object: "page",
						id: "page-123",
						url: "https://www.notion.so/page-123",
						properties: {
							title: {
								title: [{ plain_text: "Product Requirements" }],
							},
						},
					},
				],
				has_more: false,
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-4",
			provider: "NOTION",
			providerConfig: {
				includePages: true,
			},
			credentials: { accessToken: "secret_notion" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "page-123",
				name: "Product Requirements",
				type: "notion-page",
			}),
		]);
	});

	it("fetches Notion page blocks as searchable markdown documents", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					id: "page-123",
					url: "https://www.notion.so/page-123",
					last_edited_time: "2026-04-03T11:00:00.000Z",
					properties: {
						Name: {
							title: [{ plain_text: "PRD" }],
						},
					},
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					results: [
						{
							id: "block-1",
							type: "heading_1",
							heading_1: {
								rich_text: [{ plain_text: "Authentication" }],
							},
							has_children: false,
						},
						{
							id: "block-2",
							type: "paragraph",
							paragraph: {
								rich_text: [
									{
										plain_text:
											"Use SSO and SCIM provisioning.",
									},
								],
							},
							has_children: false,
						},
					],
					has_more: false,
				}),
			} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-4",
			provider: "NOTION",
			resource: {
				id: "page-123",
				name: "PRD",
				type: "notion-page",
				metadata: { pageId: "page-123" },
			},
			credentials: { accessToken: "secret_notion" },
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "notion:page:page-123",
				title: "PRD",
				content: expect.stringContaining(
					"Use SSO and SCIM provisioning.",
				),
			}),
		);
		expect(result.newCursor?.provider).toBe("NOTION");
	});
});

describe("connector sync Google Drive provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Google Drive files through the generic connector path", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				files: [
					{
						id: "drive-file-1",
						name: "PRD Doc",
						mimeType: "application/vnd.google-apps.document",
						webViewLink:
							"https://drive.google.com/file/d/drive-file-1/view",
						modifiedTime: "2026-04-03T12:00:00.000Z",
					},
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-5",
			provider: "GOOGLE_DRIVE",
			providerConfig: {
				includeSharedDrives: true,
			},
			credentials: { accessToken: "google-token" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "drive-file-1",
				name: "PRD Doc",
				type: "google-drive-file",
				metadata: expect.objectContaining({
					mimeType: "application/vnd.google-apps.document",
				}),
			}),
		]);
		expect(global.fetch).toHaveBeenCalledWith(
			expect.stringContaining(
				"https://www.googleapis.com/drive/v3/files?",
			),
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer google-token",
				}),
			}),
		);
	});

	it("fetches Google Drive document content as searchable markdown", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					id: "drive-file-1",
					name: "PRD Doc",
					mimeType: "application/vnd.google-apps.document",
					webViewLink:
						"https://drive.google.com/file/d/drive-file-1/view",
					modifiedTime: "2026-04-03T12:30:00.000Z",
					size: "128",
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				text: async () =>
					"Authentication requirements\n\nUse SSO for enterprise tenants.",
			} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-5",
			provider: "GOOGLE_DRIVE",
			resource: {
				id: "drive-file-1",
				name: "PRD Doc",
				type: "google-drive-file",
				metadata: { fileId: "drive-file-1" },
			},
			credentials: { accessToken: "google-token" },
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "google-drive:file:drive-file-1",
				title: "PRD Doc",
				content: expect.stringContaining(
					"Use SSO for enterprise tenants.",
				),
				metadata: expect.objectContaining({
					mimeType: "application/vnd.google-apps.document",
				}),
			}),
		);
		expect(result.newCursor).toEqual(
			expect.objectContaining({
				provider: "GOOGLE_DRIVE",
				lastSyncedAt: "2026-04-03T12:30:00.000Z",
			}),
		);
	});
});

describe("connector sync Microsoft 365 provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers OneDrive and SharePoint files through Microsoft Graph", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					value: [
						{
							id: "one-1",
							name: "Roadmap.docx",
							webUrl: "https://contoso.sharepoint.com/personal/roadmap",
							lastModifiedDateTime: "2026-04-03T12:00:00.000Z",
							size: 128,
							file: {
								mimeType:
									"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
							},
							parentReference: {
								driveId: "drive-user-1",
								path: "/drive/root:/Docs",
							},
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					value: [
						{
							id: "site-1",
							name: "Engineering",
							displayName: "Engineering",
							webUrl: "https://contoso.sharepoint.com/sites/engineering",
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					value: [
						{
							id: "sp-file-1",
							name: "Architecture.md",
							webUrl: "https://contoso.sharepoint.com/sites/engineering/Architecture.md",
							lastModifiedDateTime: "2026-04-03T13:00:00.000Z",
							size: 64,
							file: { mimeType: "text/markdown" },
							parentReference: {
								driveId: "drive-site-1",
								path: "/drive/root:/Shared Documents",
							},
						},
					],
				}),
			} as Response);

		const resources = await discoverResources({
			connectorId: "conn-ms-1",
			provider: "MICROSOFT_365",
			providerConfig: {
				includeOneDrive: true,
				includeSharePoint: true,
			},
			credentials: { accessToken: "ms-token" },
		});

		expect(resources).toHaveLength(2);
		expect(resources[0]).toEqual(
			expect.objectContaining({
				id: "onedrive:one-1",
				type: "microsoft-drive-item",
				metadata: expect.objectContaining({
					source: "onedrive",
					driveId: "drive-user-1",
				}),
			}),
		);
		expect(resources[1]).toEqual(
			expect.objectContaining({
				id: "sharepoint:site-1:sp-file-1",
				type: "microsoft-drive-item",
				metadata: expect.objectContaining({
					source: "sharepoint",
					siteId: "site-1",
					driveId: "drive-site-1",
				}),
			}),
		);
	});

	it("discovers paginated SharePoint files for explicit siteIds", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					id: "site-42",
					name: "Product",
					displayName: "Product",
					webUrl: "https://contoso.sharepoint.com/sites/product",
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					value: [
						{
							id: "sp-file-1",
							name: "Roadmap.md",
							webUrl: "https://contoso.sharepoint.com/sites/product/Roadmap.md",
							lastModifiedDateTime: "2026-04-03T13:00:00.000Z",
							size: 64,
							file: { mimeType: "text/markdown" },
							parentReference: {
								driveId: "drive-site-42",
								path: "/drive/root:/Shared Documents",
							},
						},
					],
					"@odata.nextLink":
						"https://graph.microsoft.com/v1.0/sites/site-42/drive/root/children?$skiptoken=next",
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					value: [
						{
							id: "sp-file-2",
							name: "Architecture.md",
							webUrl: "https://contoso.sharepoint.com/sites/product/Architecture.md",
							lastModifiedDateTime: "2026-04-03T13:05:00.000Z",
							size: 72,
							file: { mimeType: "text/markdown" },
							parentReference: {
								driveId: "drive-site-42",
								path: "/drive/root:/Shared Documents",
							},
						},
					],
				}),
			} as Response);

		const resources = await discoverResources({
			connectorId: "conn-ms-site",
			provider: "MICROSOFT_365",
			providerConfig: {
				includeOneDrive: false,
				includeSharePoint: true,
				siteIds: ["site-42"],
			},
			credentials: { accessToken: "ms-token" },
		});

		expect(resources).toHaveLength(2);
		expect(resources.map((resource) => resource.id)).toEqual([
			"sharepoint:site-42:sp-file-1",
			"sharepoint:site-42:sp-file-2",
		]);
		expect(vi.mocked(global.fetch)).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining(
				"/sites/site-42?%24select=id%2Cname%2CdisplayName%2CwebUrl",
			),
			expect.anything(),
		);
		expect(vi.mocked(global.fetch)).toHaveBeenNthCalledWith(
			3,
			"https://graph.microsoft.com/v1.0/sites/site-42/drive/root/children?$skiptoken=next",
			expect.anything(),
		);
	});

	it("fetches Microsoft drive item content as searchable documents", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					id: "one-1",
					name: "Roadmap.md",
					webUrl: "https://contoso.sharepoint.com/personal/roadmap",
					lastModifiedDateTime: "2026-04-03T15:00:00.000Z",
					size: 144,
					file: { mimeType: "text/markdown" },
					parentReference: {
						path: "/drive/root:/Docs",
					},
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				text: async () =>
					"# Delivery Plan\n\nUse weekly checkpoints and shared PRDs.",
			} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-ms-1",
			provider: "MICROSOFT_365",
			resource: {
				id: "onedrive:one-1",
				name: "Roadmap.md",
				type: "microsoft-drive-item",
				metadata: {
					itemId: "one-1",
					driveId: "drive-user-1",
					source: "onedrive",
				},
			},
			credentials: { accessToken: "ms-token" },
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "microsoft:onedrive:one-1",
				title: "Roadmap.md",
				content: expect.stringContaining(
					"Use weekly checkpoints and shared PRDs.",
				),
				metadata: expect.objectContaining({
					source: "onedrive",
					driveId: "drive-user-1",
				}),
			}),
		);
		expect(result.newCursor).toEqual(
			expect.objectContaining({
				provider: "MICROSOFT_365",
				lastSyncedAt: "2026-04-03T15:00:00.000Z",
			}),
		);
	});

	it("preserves SharePoint metadata on fetched documents", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					id: "sp-file-1",
					name: "Architecture.md",
					webUrl: "https://contoso.sharepoint.com/sites/engineering/Architecture.md",
					lastModifiedDateTime: "2026-04-03T16:00:00.000Z",
					size: 144,
					file: { mimeType: "text/markdown" },
					parentReference: {
						path: "/drive/root:/Shared Documents",
					},
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				text: async () =>
					"# Architecture\n\nUse service boundaries and contracts.",
			} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-ms-sp",
			provider: "MICROSOFT_365",
			resource: {
				id: "sharepoint:site-1:sp-file-1",
				name: "Architecture.md",
				type: "microsoft-drive-item",
				metadata: {
					itemId: "sp-file-1",
					driveId: "drive-site-1",
					source: "sharepoint",
					siteId: "site-1",
					siteName: "Engineering",
				},
			},
			credentials: { accessToken: "ms-token" },
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "microsoft:sharepoint:sp-file-1",
				metadata: expect.objectContaining({
					source: "sharepoint",
					siteId: "site-1",
					siteName: "Engineering",
				}),
			}),
		);
	});
});

describe("connector sync Teams provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Teams channels from joined teams", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					value: [
						{
							id: "team-1",
							displayName: "Engineering",
							webUrl: "https://teams.microsoft.com/l/team/19%3Ateam-1",
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					value: [
						{
							id: "channel-1",
							displayName: "Platform",
							webUrl: "https://teams.microsoft.com/l/channel/19%3Achannel-1",
							membershipType: "standard",
						},
					],
				}),
			} as Response);

		const resources = await discoverResources({
			connectorId: "conn-teams-1",
			provider: "TEAMS",
			providerConfig: {},
			credentials: { accessToken: "ms-token" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "teams:channel:team-1:channel-1",
				type: "teams-channel",
				metadata: expect.objectContaining({
					teamId: "team-1",
					channelId: "channel-1",
				}),
			}),
		]);
	});

	it("fetches Teams channel messages as searchable documents", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				value: [
					{
						id: "message-1",
						createdDateTime: "2026-04-03T11:00:00.000Z",
						lastModifiedDateTime: "2026-04-03T11:05:00.000Z",
						from: { user: { displayName: "Priya" } },
						body: {
							content:
								"<p>Please update the launch checklist.</p>",
						},
					},
					{
						id: "message-2",
						createdDateTime: "2026-04-03T12:00:00.000Z",
						lastModifiedDateTime: "2026-04-03T12:10:00.000Z",
						from: { user: { displayName: "Ravi" } },
						body: { content: "<p>Done. Also linked the PRD.</p>" },
					},
				],
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-teams-1",
			provider: "TEAMS",
			resource: {
				id: "teams:channel:team-1:channel-1",
				name: "Platform",
				type: "teams-channel",
				metadata: {
					teamId: "team-1",
					teamName: "Engineering",
					channelId: "channel-1",
					channelName: "Platform",
				},
			},
			credentials: { accessToken: "ms-token" },
			syncType: "incremental",
			cursor: {
				connectorId: "conn-teams-1",
				provider: "TEAMS",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00.000Z",
				lastSyncedAt: "2026-04-01T00:00:00.000Z",
			},
			batchSize: 50,
		});

		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "teams:channel:team-1:channel-1",
				title: "Platform",
				content: expect.stringContaining("Done. Also linked the PRD."),
				metadata: expect.objectContaining({
					teamName: "Engineering",
					messageCount: 2,
				}),
			}),
		);
		expect(result.newCursor?.provider).toBe("TEAMS");
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T12:10:00.000Z");
	});
});

describe("connector sync Snowflake provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Snowflake tables from information schema", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: [
					["CUSTOMERS", "Customer master table"],
					["ORDERS", "Order facts"],
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-snow-1",
			provider: "SNOWFLAKE",
			providerConfig: {
				accountIdentifier: "acme-org",
				database: "ANALYTICS",
				schema: "PUBLIC",
			},
			credentials: {
				apiKey: "snowflake-token",
			},
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "snowflake:ANALYTICS.PUBLIC.CUSTOMERS",
				name: "CUSTOMERS",
				type: "snowflake-table",
			}),
			expect.objectContaining({
				id: "snowflake:ANALYTICS.PUBLIC.ORDERS",
				name: "ORDERS",
				type: "snowflake-table",
			}),
		]);
	});

	it("fetches Snowflake table snapshots as searchable documents", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: [
					["cust_1", "Acme Corp", "Enterprise"],
					["cust_2", "Globex", "Growth"],
				],
				resultSetMetaData: {
					rowType: [
						{ name: "CUSTOMER_ID" },
						{ name: "NAME" },
						{ name: "SEGMENT" },
					],
				},
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-snow-1",
			provider: "SNOWFLAKE",
			resource: {
				id: "snowflake:ANALYTICS.PUBLIC.CUSTOMERS",
				name: "CUSTOMERS",
				type: "snowflake-table",
				metadata: {
					database: "ANALYTICS",
					schema: "PUBLIC",
					tableName: "CUSTOMERS",
				},
			},
			credentials: {
				apiKey: "snowflake-token",
			},
			providerConfig: {
				accountIdentifier: "acme-org",
				database: "ANALYTICS",
				schema: "PUBLIC",
				maxRowsPerTable: 25,
			},
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "snowflake:ANALYTICS.PUBLIC.CUSTOMERS",
				title: "ANALYTICS.PUBLIC.CUSTOMERS",
				content: expect.stringContaining("CUSTOMER_ID: cust_1"),
				metadata: expect.objectContaining({
					tableName: "CUSTOMERS",
					rowCountSampled: 2,
				}),
			}),
		);
		expect(result.newCursor?.provider).toBe("SNOWFLAKE");
	});
});

describe("connector sync BigQuery provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers BigQuery tables from a configured dataset", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				tables: [
					{
						tableReference: {
							projectId: "fabric-prod",
							datasetId: "analytics",
							tableId: "customers",
						},
						friendlyName: "Customers",
						description: "Customer master table",
					},
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-bq-1",
			provider: "BIGQUERY",
			providerConfig: {
				projectId: "fabric-prod",
				datasetId: "analytics",
			},
			credentials: {
				apiKey: "bigquery-token",
			},
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "bigquery:fabric-prod.analytics.customers",
				name: "Customers",
				type: "bigquery-table",
			}),
		]);
	});

	it("fetches BigQuery table snapshots as searchable documents", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				schema: {
					fields: [
						{ name: "customer_id" },
						{ name: "name" },
						{ name: "segment" },
					],
				},
				rows: [
					{
						f: [
							{ v: "cust_1" },
							{ v: "Acme Corp" },
							{ v: "Enterprise" },
						],
					},
					{
						f: [{ v: "cust_2" }, { v: "Globex" }, { v: "Growth" }],
					},
				],
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-bq-1",
			provider: "BIGQUERY",
			resource: {
				id: "bigquery:fabric-prod.analytics.customers",
				name: "customers",
				type: "bigquery-table",
				metadata: {
					projectId: "fabric-prod",
					datasetId: "analytics",
					tableName: "customers",
				},
			},
			credentials: {
				apiKey: "bigquery-token",
			},
			providerConfig: {
				projectId: "fabric-prod",
				datasetId: "analytics",
				maxRowsPerTable: 25,
			},
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "bigquery:fabric-prod.analytics.customers",
				title: "fabric-prod.analytics.customers",
				content: expect.stringContaining("customer_id: cust_1"),
				metadata: expect.objectContaining({
					tableName: "customers",
					rowCountSampled: 2,
				}),
			}),
		);
		expect(result.newCursor?.provider).toBe("BIGQUERY");
	});
});

describe("connector sync Gmail provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Gmail threads as searchable resources", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				threads: [
					{
						id: "thread-1",
						snippet: "PRD review follow-up",
						historyId: "5001",
					},
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-gmail-1",
			provider: "GMAIL",
			providerConfig: {
				labelIds: ["INBOX"],
				includeSpamTrash: false,
			},
			credentials: { accessToken: "gmail-token" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "gmail:thread:thread-1",
				type: "gmail-thread",
				metadata: expect.objectContaining({
					threadId: "thread-1",
					historyId: "5001",
				}),
			}),
		]);
	});

	it("fetches Gmail threads as searchable documents", async () => {
		const plainText = Buffer.from(
			"Please update the PRD before Friday.",
			"utf8",
		).toString("base64url");
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				id: "thread-1",
				historyId: "5002",
				snippet: "Please update the PRD before Friday.",
				messages: [
					{
						id: "message-1",
						internalDate: "1775232000000",
						payload: {
							headers: [
								{ name: "Subject", value: "PRD Review" },
								{ name: "From", value: "pm@example.com" },
								{ name: "To", value: "team@example.com" },
								{
									name: "Date",
									value: "Thu, 03 Apr 2026 10:00:00 +0000",
								},
							],
							parts: [
								{
									mimeType: "text/plain",
									body: { data: plainText },
								},
							],
						},
					},
				],
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-gmail-1",
			provider: "GMAIL",
			resource: {
				id: "gmail:thread:thread-1",
				name: "PRD Review",
				type: "gmail-thread",
				metadata: {
					threadId: "thread-1",
				},
			},
			credentials: { accessToken: "gmail-token" },
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "gmail:thread:thread-1",
				title: "PRD Review",
				content: expect.stringContaining(
					"Please update the PRD before Friday.",
				),
				metadata: expect.objectContaining({
					threadId: "thread-1",
					messageCount: 1,
				}),
			}),
		);
		expect(result.newCursor).toEqual(
			expect.objectContaining({
				provider: "GMAIL",
			}),
		);
	});
});

describe("connector sync Zendesk provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Zendesk articles and tickets as searchable resources", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					articles: [
						{
							id: 101,
							title: "SSO Setup",
							html_url:
								"https://acme.zendesk.com/hc/en-us/articles/101",
							updated_at: "2026-04-03T09:00:00.000Z",
							label_names: ["sso"],
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					tickets: [
						{
							id: 501,
							subject: "Login broken for EU users",
							updated_at: "2026-04-03T10:00:00.000Z",
							status: "open",
						},
					],
				}),
			} as Response);

		const resources = await discoverResources({
			connectorId: "conn-zd-1",
			provider: "ZENDESK",
			providerConfig: {
				includeArticles: true,
				includeTickets: true,
			},
			credentials: {
				domain: "acme",
				email: "support@example.com",
				apiToken: "zd-token",
			},
		});

		expect(resources).toHaveLength(2);
		expect(resources[0]).toEqual(
			expect.objectContaining({
				id: "zendesk:article:101",
				type: "zendesk-article",
			}),
		);
		expect(resources[1]).toEqual(
			expect.objectContaining({
				id: "zendesk:ticket:501",
				type: "zendesk-ticket",
			}),
		);
	});

	it("fetches Zendesk article documents", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				article: {
					id: 101,
					title: "SSO Setup",
					body: "<p>Enable SAML and test with a staging tenant.</p>",
					html_url: "https://acme.zendesk.com/hc/en-us/articles/101",
					updated_at: "2026-04-03T09:00:00.000Z",
					label_names: ["sso"],
				},
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-zd-1",
			provider: "ZENDESK",
			resource: {
				id: "zendesk:article:101",
				name: "SSO Setup",
				type: "zendesk-article",
				metadata: {
					sourceType: "article",
					articleId: "101",
				},
			},
			credentials: {
				domain: "acme",
				email: "support@example.com",
				apiToken: "zd-token",
			},
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "zendesk:article:101",
				title: "SSO Setup",
				content: expect.stringContaining("Enable SAML"),
			}),
		);
	});

	it("fetches Zendesk ticket documents with comments", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ticket: {
						id: 501,
						subject: "Login broken for EU users",
						description: "Users in Frankfurt cannot authenticate.",
						status: "open",
						priority: "high",
						updated_at: "2026-04-03T10:00:00.000Z",
					},
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					comments: [
						{
							id: 1,
							body: "Investigating the EU auth cluster now.",
							public: false,
							created_at: "2026-04-03T10:10:00.000Z",
						},
					],
				}),
			} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-zd-1",
			provider: "ZENDESK",
			resource: {
				id: "zendesk:ticket:501",
				name: "Login broken for EU users",
				type: "zendesk-ticket",
				metadata: {
					sourceType: "ticket",
					ticketId: "501",
				},
			},
			credentials: {
				domain: "acme",
				email: "support@example.com",
				apiToken: "zd-token",
			},
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "zendesk:ticket:501",
				title: "Login broken for EU users",
				content: expect.stringContaining(
					"Investigating the EU auth cluster now.",
				),
				metadata: expect.objectContaining({
					status: "open",
					commentCount: 1,
				}),
			}),
		);
	});
});

describe("connector sync Jira provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Jira issues as searchable resources", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				issues: [
					{
						id: "10001",
						key: "ENG-12",
						fields: {
							summary: "Stabilize auth retries",
							updated: "2026-04-03T11:00:00.000+0000",
							status: { name: "In Progress" },
							project: { key: "ENG", name: "Engineering" },
						},
					},
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-jira-1",
			provider: "JIRA",
			providerConfig: {
				projectKeys: ["ENG"],
			},
			credentials: {
				domain: "acme.atlassian.net",
				email: "pm@example.com",
				apiToken: "jira-token",
			},
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "jira:issue:ENG-12",
				type: "jira-issue",
				metadata: expect.objectContaining({
					projectKey: "ENG",
					status: "In Progress",
				}),
			}),
		]);
	});

	it("fetches Jira issue documents with comments", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				id: "10001",
				key: "ENG-12",
				fields: {
					summary: "Stabilize auth retries",
					description: {
						type: "doc",
						content: [
							{
								type: "paragraph",
								content: [
									{
										type: "text",
										text: "Retry budget should be capped.",
									},
								],
							},
						],
					},
					updated: "2026-04-03T11:00:00.000+0000",
					status: { name: "In Progress" },
					priority: { name: "High" },
					issuetype: { name: "Task" },
					project: { key: "ENG", name: "Engineering" },
					comment: {
						comments: [
							{
								created: "2026-04-03T11:05:00.000+0000",
								author: { displayName: "Priya" },
								body: {
									type: "doc",
									content: [
										{
											type: "paragraph",
											content: [
												{
													type: "text",
													text: "We should gate retries by tenant tier.",
												},
											],
										},
									],
								},
							},
						],
					},
				},
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-jira-1",
			provider: "JIRA",
			resource: {
				id: "jira:issue:ENG-12",
				name: "Stabilize auth retries",
				type: "jira-issue",
				metadata: {
					issueKey: "ENG-12",
				},
			},
			credentials: {
				domain: "acme.atlassian.net",
				email: "pm@example.com",
				apiToken: "jira-token",
			},
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "jira:issue:ENG-12",
				title: "Stabilize auth retries",
				content: expect.stringContaining(
					"Retry budget should be capped.",
				),
				metadata: expect.objectContaining({
					projectKey: "ENG",
					commentCount: 1,
				}),
			}),
		);
	});
});

describe("connector sync Salesforce provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Salesforce records across configured object types", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					records: [
						{
							Id: "001A",
							Name: "Acme Corp",
							LastModifiedDate: "2026-04-03T12:00:00.000+0000",
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					records: [
						{
							Id: "006A",
							Name: "Expansion Deal",
							StageName: "Negotiation",
							LastModifiedDate: "2026-04-03T13:00:00.000+0000",
						},
					],
				}),
			} as Response);

		const resources = await discoverResources({
			connectorId: "conn-sf-1",
			provider: "SALESFORCE",
			providerConfig: {
				objectTypes: ["Account", "Opportunity"],
			},
			credentials: {
				domain: "acme.my.salesforce.com",
				email: "integration@example.com",
				apiToken: "sf-token",
			},
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "salesforce:Account:001A",
				name: "Acme Corp",
				type: "salesforce-record",
			}),
			expect.objectContaining({
				id: "salesforce:Opportunity:006A",
				name: "Expansion Deal",
				type: "salesforce-record",
			}),
		]);
	});

	it("fetches Salesforce records as searchable documents", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				records: [
					{
						Id: "001A",
						Name: "Acme Corp",
						Type: "Customer",
						Industry: "Software",
						Description: "Strategic enterprise account",
						LastModifiedDate: "2026-04-03T14:00:00.000+0000",
					},
				],
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-sf-1",
			provider: "SALESFORCE",
			resource: {
				id: "salesforce:Account:001A",
				name: "Acme Corp",
				type: "salesforce-record",
				metadata: {
					objectType: "Account",
					recordId: "001A",
				},
			},
			credentials: {
				domain: "acme.my.salesforce.com",
				email: "integration@example.com",
				apiToken: "sf-token",
			},
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "salesforce:Account:001A",
				title: "Acme Corp",
				content: expect.stringContaining("Industry: Software"),
			}),
		);
	});
});

describe("connector sync HubSpot provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers HubSpot CRM records through paginated object endpoints", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					results: [
						{
							id: "201",
							properties: {
								firstname: "Test",
								lastname: "User",
								email: "test-user@example.com",
							},
							updatedAt: "2026-04-03T12:00:00.000Z",
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					results: [
						{
							id: "301",
							properties: {
								name: "Example Corp",
								domain: "example.com",
							},
							updatedAt: "2026-04-03T13:00:00.000Z",
						},
					],
				}),
			} as Response);

		const resources = await discoverResources({
			connectorId: "conn-hs-1",
			provider: "HUBSPOT",
			providerConfig: {
				objectTypes: ["contacts", "companies"],
			},
			credentials: {
				apiKey: "hubspot-private-token",
			},
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "hubspot:contacts:201",
				name: "Test User",
				type: "hubspot-record",
			}),
			expect.objectContaining({
				id: "hubspot:companies:301",
				name: "Example Corp",
				type: "hubspot-record",
			}),
		]);
	});

	it("fetches HubSpot records as searchable documents", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				id: "401",
				properties: {
					dealname: "Fabric Expansion",
					amount: "250000",
					dealstage: "contractsent",
					description: "Expansion into enterprise accounts",
				},
				updatedAt: "2026-04-03T15:00:00.000Z",
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-hs-1",
			provider: "HUBSPOT",
			resource: {
				id: "hubspot:deals:401",
				name: "Fabric Expansion",
				type: "hubspot-record",
				metadata: {
					objectType: "deals",
					recordId: "401",
				},
			},
			credentials: {
				apiKey: "hubspot-private-token",
			},
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "hubspot:deals:401",
				title: "Fabric Expansion",
				content: expect.stringContaining("amount: 250000"),
			}),
		);
	});
});

describe("connector sync Intercom provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Intercom articles and conversations", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [
						{
							id: "article-1",
							title: "Getting Started",
							url: "https://help.intercom.com/en/articles/1",
							updated_at: 1775203200,
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					conversations: [
						{
							id: "conversation-1",
							updated_at: 1775206800,
							source: {
								subject: "Login issue",
							},
						},
					],
				}),
			} as Response);

		const resources = await discoverResources({
			connectorId: "conn-ic-1",
			provider: "INTERCOM",
			providerConfig: {
				includeArticles: true,
				includeConversations: true,
			},
			credentials: {
				apiKey: "intercom-token",
			},
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "intercom:article:article-1",
				name: "Getting Started",
				type: "intercom-article",
			}),
			expect.objectContaining({
				id: "intercom:conversation:conversation-1",
				name: "Login issue",
				type: "intercom-conversation",
			}),
		]);
	});

	it("fetches Intercom conversation threads as searchable documents", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				id: "conversation-1",
				updated_at: 1775206800,
				source: {
					subject: "Login issue",
					body: "<p>User cannot log in after SSO rollout.</p>",
				},
				conversation_parts: {
					conversation_parts: [
						{
							created_at: 1775206900,
							body: "<p>We reset the identity provider configuration.</p>",
							author: { name: "Support" },
						},
					],
				},
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-ic-1",
			provider: "INTERCOM",
			resource: {
				id: "intercom:conversation:conversation-1",
				name: "Login issue",
				type: "intercom-conversation",
				metadata: {
					conversationId: "conversation-1",
				},
			},
			credentials: {
				apiKey: "intercom-token",
			},
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "intercom:conversation:conversation-1",
				title: "Login issue",
				content: expect.stringContaining(
					"We reset the identity provider configuration.",
				),
			}),
		);
	});
});

describe("connector sync Linear provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Linear issues as searchable resources", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: {
					issues: {
						nodes: [
							{
								id: "lin-1",
								identifier: "ENG-42",
								title: "Improve retry backoff",
								url: "https://linear.app/acme/issue/ENG-42",
								updatedAt: "2026-04-03T12:00:00.000Z",
								state: { name: "In Progress" },
								team: { key: "ENG", name: "Engineering" },
							},
						],
					},
				},
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-linear-1",
			provider: "LINEAR",
			providerConfig: {
				teamKeys: ["ENG"],
			},
			credentials: { apiKey: "linear-token" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "linear:issue:ENG-42",
				type: "linear-issue",
				metadata: expect.objectContaining({
					teamKey: "ENG",
					status: "In Progress",
				}),
			}),
		]);
	});

	it("fetches Linear issues as searchable documents", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: {
					issues: {
						nodes: [
							{
								id: "lin-1",
								identifier: "ENG-42",
								title: "Improve retry backoff",
								url: "https://linear.app/acme/issue/ENG-42",
								description:
									"We should stop retry storms during outages.",
								updatedAt: "2026-04-03T12:00:00.000Z",
								priorityLabel: "High",
								state: { name: "In Progress" },
								team: { key: "ENG", name: "Engineering" },
								comments: {
									nodes: [
										{
											body: "Cap retries per tenant and region.",
										},
									],
								},
							},
						],
					},
				},
			}),
		} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-linear-1",
			provider: "LINEAR",
			resource: {
				id: "linear:issue:ENG-42",
				name: "Improve retry backoff",
				type: "linear-issue",
				metadata: {
					issueKey: "ENG-42",
				},
			},
			credentials: { apiKey: "linear-token" },
			syncType: "full",
			batchSize: 50,
		});

		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "linear:issue:ENG-42",
				title: "Improve retry backoff",
				content: expect.stringContaining(
					"Cap retries per tenant and region.",
				),
				metadata: expect.objectContaining({
					teamKey: "ENG",
					commentCount: 1,
				}),
			}),
		);
	});
});

describe("connector sync Asana provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers Asana tasks as searchable resources", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: [
					{
						gid: "task-1",
						name: "Launch runbook",
						permalink_url:
							"https://app.asana.com/0/12001234/task-1/f",
						modified_at: "2026-04-03T12:00:00.000Z",
						resource_subtype: "default_task",
						projects: [{ gid: "proj-1", name: "Launch" }],
						memberships: [
							{
								project: { gid: "proj-1", name: "Launch" },
								section: { gid: "sec-1", name: "In Progress" },
							},
						],
					},
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-asana-1",
			provider: "ASANA",
			providerConfig: {
				workspaceId: "12001234",
			},
			credentials: { apiKey: "asana-token" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "asana:task:task-1",
				type: "asana-task",
				metadata: expect.objectContaining({
					projectName: "Launch",
					sectionName: "In Progress",
				}),
			}),
		]);
	});

	it("fetches Asana tasks as searchable documents", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: {
						gid: "task-1",
						name: "Launch runbook",
						notes: "Document rollback and escalation steps.",
						permalink_url:
							"https://app.asana.com/0/12001234/task-1/f",
						completed: false,
						modified_at: "2026-04-03T13:00:00.000Z",
						resource_subtype: "default_task",
						assignee: { name: "Priya" },
						projects: [{ gid: "proj-1", name: "Launch" }],
					},
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [
						{
							gid: "story-1",
							text: "Add the customer comms template.",
							created_at: "2026-04-03T13:05:00.000Z",
							created_by: { name: "Ravi" },
						},
					],
				}),
			} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-asana-1",
			provider: "ASANA",
			resource: {
				id: "asana:task:task-1",
				name: "Launch runbook",
				type: "asana-task",
				metadata: {
					taskId: "task-1",
				},
			},
			credentials: { apiKey: "asana-token" },
			syncType: "incremental",
			cursor: {
				connectorId: "conn-asana-1",
				provider: "ASANA",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00.000Z",
				lastSyncedAt: "2026-04-01T00:00:00.000Z",
			},
			batchSize: 50,
		});

		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "asana:task:task-1",
				title: "Launch runbook",
				content: expect.stringContaining(
					"Add the customer comms template.",
				),
				metadata: expect.objectContaining({
					projectName: "Launch",
					completed: false,
				}),
			}),
		);
		expect(result.newCursor?.provider).toBe("ASANA");
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T13:00:00.000Z");
	});
});

describe("connector sync ClickUp provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
	});

	it("discovers ClickUp tasks as searchable resources", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				tasks: [
					{
						id: "cu-1",
						name: "Improve retry backoff",
						url: "https://app.clickup.com/t/cu-1",
						date_updated: "2026-04-03T12:00:00.000Z",
						status: { status: "in progress" },
						list: { id: "list-1", name: "Engineering" },
					},
				],
			}),
		} as Response);

		const resources = await discoverResources({
			connectorId: "conn-clickup-1",
			provider: "CLICKUP",
			providerConfig: {
				listIds: ["list-1"],
				includeClosed: true,
			},
			credentials: { apiKey: "clickup-token" },
		});

		expect(resources).toEqual([
			expect.objectContaining({
				id: "clickup:task:cu-1",
				type: "clickup-task",
				metadata: expect.objectContaining({
					listId: "list-1",
					status: "in progress",
				}),
			}),
		]);
	});

	it("fetches ClickUp tasks as searchable documents", async () => {
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					id: "cu-1",
					name: "Improve retry backoff",
					description: "Tighten retry limits for transient errors.",
					url: "https://app.clickup.com/t/cu-1",
					date_updated: "2026-04-03T13:00:00.000Z",
					status: { status: "in progress" },
					priority: { priority: "high" },
					list: { id: "list-1", name: "Engineering" },
					assignees: [{ username: "test-user" }],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					comments: [
						{
							comment_text:
								"Need to account for 429 retries too.",
							date: "2026-04-03T13:05:00.000Z",
							user: { username: "alex" },
						},
					],
				}),
			} as Response);

		const result = await fetchResourceDocuments({
			connectorId: "conn-clickup-1",
			provider: "CLICKUP",
			resource: {
				id: "clickup:task:cu-1",
				name: "Improve retry backoff",
				type: "clickup-task",
				path: "https://app.clickup.com/t/cu-1",
				metadata: {
					taskId: "cu-1",
					listId: "list-1",
				},
			},
			credentials: { apiKey: "clickup-token" },
			syncType: "incremental",
			cursor: {
				connectorId: "conn-clickup-1",
				provider: "CLICKUP",
				cursorType: "incremental",
				cursor: "2026-04-01T00:00:00Z",
				lastSyncedAt: "2026-04-01T00:00:00Z",
			},
			batchSize: 50,
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toEqual(
			expect.objectContaining({
				externalId: "clickup:task:cu-1",
				title: "Improve retry backoff",
				content: expect.stringContaining(
					"Need to account for 429 retries too.",
				),
			}),
		);
		expect(result.newCursor?.lastSyncedAt).toBe("2026-04-03T13:00:00.000Z");
	});
});
