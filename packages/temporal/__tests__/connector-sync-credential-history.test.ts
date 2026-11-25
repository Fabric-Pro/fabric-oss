import { resolve } from "node:path";
import {
	db,
	getDataConnectionSyncMetadata,
	isOrganizationMember,
} from "@repo/database";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { ApplicationFailure } from "@temporalio/common";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	discoverResources,
	fetchResourceDocuments,
	garbageCollect,
	loadConnectorConfig,
	testConnection,
} from "../src/activities/connector-sync";
import { resolveConnectorSyncConnection } from "../src/activities/connector-sync/lib/connection-credential";
import {
	CONNECTOR_SYNC_PROVIDER_RETURNED_CREDENTIAL,
	callConnectorProvider,
} from "../src/activities/connector-sync/lib/provider-call";
import {
	discoverNotionResources,
	fetchNotionResourceDocuments,
	testNotionConnection,
} from "../src/activities/connector-sync/providers/knowledge";
import { CONNECTOR_SYNC_ACTIVITY_TASK_QUEUE } from "../src/task-queues";
import {
	CONNECTOR_SYNC_CONNECTION_NOT_AUTHORIZED,
	CONNECTOR_SYNC_CREDENTIAL_UNREADABLE,
	CONNECTOR_SYNC_ORGANIZATION_REQUIRED,
	CONNECTOR_SYNC_PROVIDER_MISMATCH,
} from "../src/workflows/connector-sync/connection-failures";
import type { ConnectorSyncOutput } from "../src/workflows/connector-sync/types";

vi.mock("@repo/database", () => ({
	db: { dataConnection: { findFirst: vi.fn() } },
	getConnectionWithCredentials: vi.fn(),
	getDataConnectionSyncMetadata: vi.fn(),
	isOrganizationMember: vi.fn(),
}));
vi.mock("@repo/ai", () => ({}));
vi.mock("@repo/rag", () => ({}));
vi.mock("@repo/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/utils")>();
	return { ...actual, decryptApiKey: vi.fn(actual.decryptApiKey) };
});
vi.mock("../src/activities/connector-sync/providers/knowledge", () => ({
	discoverNotionResources: vi.fn(),
	fetchNotionResourceDocuments: vi.fn(),
	testNotionConnection: vi.fn(),
}));

const ref = {
	connectorId: "example-connection",
	organizationId: "example-org",
	userId: "example-user",
	provider: "NOTION",
};
const credentials = {
	accessToken: "example-not-a-real-token-3691",
	refreshToken: "example-not-a-real-refresh",
	apiKey: "example-not-a-real-api-key",
	access_token: "example-not-a-real-inline-access",
	refresh_token: "example-not-a-real-inline-refresh",
	user_access_token: "example-not-a-real-inline-user-token",
	email: "dev@example.com",
};
const providerConfig = { databaseIds: ["example-database"] };
const resource = {
	id: "example-resource",
	name: "Example resource",
	type: "database",
};

type StoredRow = Omit<
	ReturnType<typeof storedRow>,
	"credential" | "refreshToken"
> & {
	refreshToken: string | null;
	credential: {
		organizationId: string | null;
		encryptedPayload: string;
	} | null;
};

function storedRow() {
	return {
		id: ref.connectorId,
		organizationId: ref.organizationId as string | null,
		provider: ref.provider,
		config: providerConfig,
		accessToken: encryptApiKey(credentials.accessToken),
		refreshToken: encryptApiKey(credentials.refreshToken),
		credentialId: "example-saved-credential" as string | null,
		credential: {
			organizationId: ref.organizationId,
			encryptedPayload: encryptApiKey(
				JSON.stringify({
					apiKey: credentials.apiKey,
					accessToken: "example-shadowed-access-token",
					access_token: "example-shadowed-inline-token",
				}),
			),
		},
		credentials: encryptApiKey(
			JSON.stringify({
				accessToken: credentials.accessToken,
				access_token: credentials.access_token,
				refresh_token: credentials.refresh_token,
				user_access_token: credentials.user_access_token,
				email: credentials.email,
			}),
		) as string | Record<string, unknown> | null,
	};
}

function rows(...stored: StoredRow[]) {
	vi.mocked(db.dataConnection.findFirst).mockImplementation(
		(async ({
			where,
		}: {
			where?: { id?: string; organizationId?: string };
		} = {}) =>
			stored.find(
				(row) =>
					(where?.id === undefined || row.id === where.id) &&
					(where?.organizationId === undefined ||
						row.organizationId === where.organizationId),
			) ?? null) as unknown as typeof db.dataConnection.findFirst,
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv(
		"ENCRYPTION_KEYS",
		JSON.stringify({ example: "example-local-encryption-key" }),
	);
	vi.stubEnv("ENCRYPTION_ACTIVE_KEY_VERSION", "example");
	vi.mocked(isOrganizationMember).mockResolvedValue(true);
	vi.mocked(getDataConnectionSyncMetadata).mockResolvedValue({
		id: ref.connectorId,
		provider: "NOTION",
		name: "Example connection",
		status: "SYNCING",
		config: providerConfig,
		lastSyncAt: null,
	});
	vi.mocked(testNotionConnection).mockResolvedValue(true);
	vi.mocked(discoverNotionResources).mockResolvedValue([resource]);
	vi.mocked(fetchNotionResourceDocuments).mockResolvedValue({
		documents: [],
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("connector sync connection resolution", () => {
	async function expectTestRefusal(type: string, input = ref) {
		await expect(testConnection(input)).rejects.toMatchObject({
			type,
			nonRetryable: true,
		});
		expect(testNotionConnection).not.toHaveBeenCalled();
	}

	it.each(["example-other-org", null])(
		"refuses a connection owned by %s before decrypting",
		async (organizationId) => {
			rows({ ...storedRow(), organizationId });
			await expectTestRefusal(CONNECTOR_SYNC_CONNECTION_NOT_AUTHORIZED);
			expect(decryptApiKey).not.toHaveBeenCalled();
		},
	);

	it("refuses a different connection id in the same organization", async () => {
		rows({ ...storedRow(), id: "example-other-connection" });
		await expectTestRefusal(CONNECTOR_SYNC_CONNECTION_NOT_AUTHORIZED);
		expect(decryptApiKey).not.toHaveBeenCalled();
	});

	it("refuses a missing organization before making a database read", async () => {
		rows(storedRow());
		const { organizationId: _organizationId, ...input } = ref;
		await expect(testConnection(input)).rejects.toMatchObject({
			type: CONNECTOR_SYNC_ORGANIZATION_REQUIRED,
			nonRetryable: true,
		});
		expect(isOrganizationMember).not.toHaveBeenCalled();
		expect(db.dataConnection.findFirst).not.toHaveBeenCalled();
		expect(decryptApiKey).not.toHaveBeenCalled();
		expect(testNotionConnection).not.toHaveBeenCalled();
	});

	it("refuses a starting actor who no longer belongs to the organization", async () => {
		rows(storedRow());
		vi.mocked(isOrganizationMember).mockResolvedValue(false);
		await expectTestRefusal(CONNECTOR_SYNC_CONNECTION_NOT_AUTHORIZED);
		expect(isOrganizationMember).toHaveBeenCalledWith(
			ref.userId,
			ref.organizationId,
		);
		expect(db.dataConnection.findFirst).not.toHaveBeenCalled();
		expect(decryptApiKey).not.toHaveBeenCalled();
	});

	it.each(["example-other-org", null])(
		"refuses a saved credential owned by %s before decrypting",
		async (organizationId) => {
			const row = storedRow();
			rows({
				...row,
				credential: {
					encryptedPayload: row.credential.encryptedPayload,
					organizationId,
				},
			});
			await expectTestRefusal(CONNECTOR_SYNC_CONNECTION_NOT_AUTHORIZED);
			expect(decryptApiKey).not.toHaveBeenCalled();
		},
	);

	it("refuses a saved credential whose relation cannot be read", async () => {
		rows({ ...storedRow(), credential: null });
		await expectTestRefusal(CONNECTOR_SYNC_CONNECTION_NOT_AUTHORIZED);
		expect(decryptApiKey).not.toHaveBeenCalled();
	});

	it.each(["accessToken", "refreshToken", "credentials", "saved"] as const)(
		"reports unreadable %s without a decrypt message or cause",
		async (field) => {
			const row = storedRow();
			const unreadable = row.accessToken.replace(
				"kexample:",
				"kmissing:",
			);
			if (field === "saved") {
				row.credential.encryptedPayload = unreadable;
			} else {
				row[field] = unreadable;
			}
			rows(row);
			await expect(testConnection(ref)).rejects.toMatchObject({
				type: CONNECTOR_SYNC_CREDENTIAL_UNREADABLE,
				nonRetryable: true,
				message:
					"The saved data connection credentials could not be read.",
				cause: undefined,
			});
			expect(decryptApiKey).toHaveBeenCalledWith(unreadable);
			expect(testNotionConnection).not.toHaveBeenCalled();
		},
	);

	it.each([
		["credentials", "not an object"],
		["credentials", [1]],
		["saved", 1],
	] as const)(
		"refuses a decrypted non-object %s payload of %j",
		async (field, value) => {
			const row = storedRow();
			const invalid = encryptApiKey(JSON.stringify(value));
			if (field === "saved") {
				row.credential.encryptedPayload = invalid;
			} else {
				row.credentials = invalid;
			}
			rows(row);
			await expectTestRefusal(CONNECTOR_SYNC_CREDENTIAL_UNREADABLE);
		},
	);

	it("refuses a mismatched input provider before reading any stored secret", async () => {
		rows({ ...storedRow(), provider: "GITHUB" });
		await expectTestRefusal(CONNECTOR_SYNC_PROVIDER_MISMATCH);
		expect(decryptApiKey).not.toHaveBeenCalled();
	});

	it("checks the row provider before taking the GitLab path", async () => {
		await expectTestRefusal(CONNECTOR_SYNC_PROVIDER_MISMATCH, {
			...ref,
			provider: "GITLAB",
		});
		expect(db.dataConnection.findFirst).not.toHaveBeenCalled();
		expect(decryptApiKey).not.toHaveBeenCalled();
	});

	it("refuses a GitLab connection missing from the authorized metadata lookup", async () => {
		vi.mocked(getDataConnectionSyncMetadata).mockResolvedValue(null);
		await expectTestRefusal(CONNECTOR_SYNC_CONNECTION_NOT_AUTHORIZED, {
			...ref,
			provider: "GITLAB",
		});
		expect(getDataConnectionSyncMetadata).toHaveBeenCalledWith({
			id: ref.connectorId,
			userId: ref.userId,
			organizationId: ref.organizationId,
		});
	});

	it("accepts an empty inline payload", async () => {
		rows({ ...storedRow(), credentials: null });
		await expect(
			resolveConnectorSyncConnection(ref),
		).resolves.toMatchObject({
			credentials: {
				apiKey: credentials.apiKey,
				refreshToken: credentials.refreshToken,
			},
		});
	});

	it("merges column, saved and inline credentials in that order and ignores stale inputs", async () => {
		const row = storedRow();
		row.accessToken = encryptApiKey("example-shadowed-column-token");
		rows(row);
		const legacyInput = {
			...ref,
			credentials: { accessToken: "example-stale-token" },
			providerConfig: { databaseIds: ["example-stale-database"] },
		};

		await expect(
			resolveConnectorSyncConnection(legacyInput),
		).resolves.toEqual({
			provider: ref.provider,
			providerConfig,
			credentials,
		});
		await expect(testConnection(legacyInput)).resolves.toBe(true);
		await expect(discoverResources(legacyInput)).resolves.toEqual([
			resource,
		]);
		await expect(
			fetchResourceDocuments({
				...legacyInput,
				resource,
				syncType: "full",
				batchSize: 1,
			}),
		).resolves.toEqual({ documents: [] });
		expect(testNotionConnection).toHaveBeenCalledWith(credentials);
		expect(discoverNotionResources).toHaveBeenCalledWith({
			credentials,
			providerConfig,
		});
		expect(fetchNotionResourceDocuments).toHaveBeenCalledWith({
			connectorId: ref.connectorId,
			resource,
			credentials,
		});
	});

	it("loads legacy plaintext tokens and inline objects without requiring a saved credential", async () => {
		const row = {
			...storedRow(),
			accessToken: credentials.accessToken,
			refreshToken: null,
			credentialId: null,
			credential: null,
			credentials: { apiKey: credentials.apiKey },
		};
		rows(row);
		await expect(
			resolveConnectorSyncConnection(ref),
		).resolves.toMatchObject({
			credentials: {
				accessToken: credentials.accessToken,
				refreshToken: null,
				apiKey: credentials.apiKey,
			},
		});
		expect(decryptApiKey).not.toHaveBeenCalled();
	});
});

describe("connector provider boundary", () => {
	const apiBasic = Buffer.from(
		`${credentials.email}:${credentials.apiKey}`,
	).toString("base64");
	const zendeskBasic = Buffer.from(
		`${credentials.email}/token:${credentials.apiKey}`,
	).toString("base64");
	const bitbucketBasic = Buffer.from(
		`example-user:${credentials.accessToken}`,
	).toString("base64");

	it("redacts raw secrets and both Basic auth forms and drops the cause", async () => {
		const error = new Error(
			`Provider refused ${credentials.user_access_token} Basic ${apiBasic} Basic ${zendeskBasic} Basic ${bitbucketBasic}`,
			{ cause: new Error(credentials.refreshToken) },
		);
		const result = callConnectorProvider(
			{
				...credentials,
				username: "example-user",
				apiToken: credentials.apiKey,
			},
			() => {
				throw error;
			},
		);
		await expect(result).rejects.toThrow(
			"Provider refused [REDACTED] Basic [REDACTED] Basic [REDACTED] Basic [REDACTED]",
		);
		await expect(result).rejects.toBeInstanceOf(Error);
		await expect(result).rejects.not.toHaveProperty("cause");
	});

	it("drops a leaking cause even when the top-level error message is clean", async () => {
		const error = new Error("Provider refused", {
			cause: new Error(credentials.refreshToken),
		});
		const result = callConnectorProvider(credentials, async () => {
			throw error;
		});
		await expect(result).rejects.toThrow("Provider refused");
		await expect(result).rejects.not.toHaveProperty("cause");
	});

	it("drops a cause with a secret in an object field", async () => {
		const error = new Error("Provider refused", {
			cause: { token: credentials.refreshToken },
		});
		const result = callConnectorProvider(credentials, async () => {
			throw error;
		});
		await expect(result).rejects.toThrow("Provider refused");
		await expect(result).rejects.not.toHaveProperty("cause");
	});

	it("passes ApplicationFailure through unchanged", async () => {
		const failure = ApplicationFailure.nonRetryable(
			credentials.accessToken,
			"EXAMPLE",
		);
		await expect(
			callConnectorProvider(credentials, async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
	});

	it("preserves ordinary errors, empty and short values, and non-secret fields", async () => {
		const error = new RangeError("example.com: No");
		await expect(
			callConnectorProvider(
				{ password: "", apiToken: "No", domain: "example.com" },
				async () => {
					throw error;
				},
			),
		).rejects.toBe(error);
	});

	it("refuses returned document fields that echo a resolved secret", async () => {
		rows(storedRow());
		vi.mocked(fetchNotionResourceDocuments).mockResolvedValue({
			documents: [
				{
					id: "example-document",
					externalId: "example-document",
					title: "Example document",
					content: credentials.access_token,
					metadata: {},
				},
			],
		});
		await expect(
			fetchResourceDocuments({
				...ref,
				resource,
				syncType: "full",
				batchSize: 1,
			}),
		).rejects.toMatchObject({
			type: CONNECTOR_SYNC_PROVIDER_RETURNED_CREDENTIAL,
			nonRetryable: true,
			message:
				"The resource was skipped because its content contains the connection's credential.",
		});
	});
});

it("keeps resolved credentials out of decoded connector sync history", async () => {
	rows(storedRow());
	const secrets = [
		...Object.values(credentials).filter(
			(value) => value !== credentials.email,
		),
		Buffer.from(`${credentials.email}:${credentials.apiKey}`).toString(
			"base64",
		),
	];
	vi.mocked(discoverNotionResources).mockResolvedValue([
		{ ...resource, id: "example-failed-resource" },
		resource,
	]);
	vi.mocked(fetchNotionResourceDocuments).mockImplementation(
		async ({ resource }) => {
			if (resource.id === "example-failed-resource") {
				throw new Error(`Provider refused ${secrets.join(" ")}`, {
					cause: new Error(credentials.refreshToken),
				});
			}
			return { documents: [] };
		},
	);

	const env = await TestWorkflowEnvironment.createTimeSkipping();
	const taskQueue = "example-connector-workflow-queue";
	try {
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowsPath: resolve(
				__dirname,
				"../src/workflows/connector-sync",
			),
			activities: {
				updateConnectorStatus: async () => {},
				scheduleNextSync: async () => {},
			},
		});
		const activityWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: CONNECTOR_SYNC_ACTIVITY_TASK_QUEUE,
			activities: {
				loadConnectorConfig,
				testConnection,
				discoverResources,
				fetchResourceDocuments,
				garbageCollect,
			},
		});
		await worker.runUntil(() =>
			activityWorker.runUntil(async () => {
				const handle = await env.client.workflow.start(
					"connectorSyncWorkflow",
					{
						taskQueue,
						workflowId: "example-connector-workflow",
						args: [{ ...ref, syncType: "gc" }],
					},
				);
				expect(
					(await handle.result()) as ConnectorSyncOutput,
				).toMatchObject({ success: true });
				const history = await handle.fetchHistory();
				expect(history.events).toBeDefined();
				const scheduled = (history.events ?? []).flatMap((event) =>
					event.activityTaskScheduledEventAttributes
						? [event.activityTaskScheduledEventAttributes]
						: [],
				);
				expect(
					scheduled.map((activity) => [
						activity.activityType?.name,
						activity.taskQueue?.name,
					]),
				).toEqual([
					["loadConnectorConfig", CONNECTOR_SYNC_ACTIVITY_TASK_QUEUE],
					["testConnection", CONNECTOR_SYNC_ACTIVITY_TASK_QUEUE],
					["discoverResources", CONNECTOR_SYNC_ACTIVITY_TASK_QUEUE],
					[
						"fetchResourceDocuments",
						CONNECTOR_SYNC_ACTIVITY_TASK_QUEUE,
					],
					[
						"fetchResourceDocuments",
						CONNECTOR_SYNC_ACTIVITY_TASK_QUEUE,
					],
					["garbageCollect", CONNECTOR_SYNC_ACTIVITY_TASK_QUEUE],
					["updateConnectorStatus", taskQueue],
					["scheduleNextSync", taskQueue],
				]);
				for (const activity of scheduled.filter(
					(entry) =>
						entry.taskQueue?.name ===
						CONNECTOR_SYNC_ACTIVITY_TASK_QUEUE,
				)) {
					expect(
						Number(activity.scheduleToStartTimeout?.seconds),
					).toBe(600);
				}
				// History payloads use Base64 in proto JSON. Decode them before searching
				// the entire history, including its activity inputs, results and failures.
				const serialized = JSON.stringify(
					JSON.parse(historyToJSON(history)),
					(key, value) =>
						key === "data" && typeof value === "string"
							? Buffer.from(value, "base64").toString("utf8")
							: value,
				);
				expect(serialized).toContain("EVENT_TYPE_ACTIVITY_TASK_FAILED");
				expect(serialized).toContain("Provider refused [REDACTED]");
				for (const secret of secrets) {
					expect(serialized).not.toContain(secret);
				}
			}),
		);
		expect(testNotionConnection).toHaveBeenCalledWith(credentials);
		expect(discoverNotionResources).toHaveBeenCalledWith({
			credentials,
			providerConfig,
		});
		expect(fetchNotionResourceDocuments).toHaveBeenCalledWith({
			connectorId: ref.connectorId,
			resource,
			credentials,
		});
	} finally {
		await env.teardown();
	}
}, 120_000);
