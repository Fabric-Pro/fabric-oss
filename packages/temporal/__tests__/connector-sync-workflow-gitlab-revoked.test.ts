/**
 * A GitLab token revoked mid-sync must end the sync in ERROR, not let
 * `continueOnError` skip every resource into a "completed" sync with zero
 * items that then runs garbage collection.
 *
 * Bundles the REAL workflow code and runs the REAL GitLab provider activities
 * (test / discover / fetch) in-process, with the connection service and the
 * network mocked: `/user` succeeds, then GitLab answers 401.
 */

import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

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

import { getGitLabConnectionToken } from "@repo/integrations/gitlab";
import {
	discoverResources,
	fetchResourceDocuments,
	testConnection,
} from "../src/activities/connector-sync";
import type { ConnectorSyncOutput } from "../src/workflows/connector-sync/types";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const realFetch = global.fetch;

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	global.fetch = realFetch;
	await env?.teardown();
});

function json(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response;
}

beforeEach(() => {
	vi.mocked(getGitLabConnectionToken).mockResolvedValue({
		ok: true,
		accessToken: "live-token",
		issuer: {
			kind: "app",
			clientId: "client-1",
			origin: "https://gitlab.com",
		},
		origin: "https://gitlab.com",
		integrationId: "wi-1",
		generation: 1,
		settings: {},
	});
});

it("ends in ERROR, without garbage collection, when GitLab answers 401 during fetch", async () => {
	// `/user` passes; every later call is refused as the token was revoked.
	global.fetch = vi.fn(async (url: string | URL | Request) =>
		String(url).endsWith("/api/v4/user")
			? json(200, { id: 1 })
			: json(401, { message: "401 Unauthorized" }),
	) as typeof fetch;

	const mocks = {
		updateSyncJobActivity: vi.fn(async () => {}),
		loadConnectorConfig: vi.fn(async () => ({
			id: "conn-1",
			provider: "GITLAB",
			name: "GitLab",
			status: "CONNECTED",
			credentials: {},
			providerConfig: { projects: ["a/b", "c/d"] },
			syncConfig: { incrementalSyncIntervalMinutes: 60 },
			lastSyncAt: null,
		})),
		testConnection: vi.fn(testConnection),
		discoverResources: vi.fn(discoverResources),
		fetchResourceDocuments: vi.fn(fetchResourceDocuments),
		loadSyncCursor: vi.fn(async () => undefined),
		storeDocuments: vi.fn(async () => ({ added: 0, updated: 0 })),
		generateEmbeddings: vi.fn(async () => ({ created: 0, updated: 0 })),
		garbageCollect: vi.fn(async () => ({ deleted: 0, vectorsDeleted: 0 })),
		saveSyncCursor: vi.fn(async () => {}),
		updateConnectorStatus: vi.fn(async () => {}),
		scheduleNextSync: vi.fn(async () => {}),
	};

	const taskQueue = "connector-sync-gitlab-revoked";
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: mocks,
	});
	const output = (await worker.runUntil(
		env.client.workflow.execute("connectorSyncWorkflow", {
			args: [
				{
					syncJobId: "job-1",
					connectorId: "conn-1",
					provider: "GITLAB",
					syncType: "gc",
					userId: "user-1",
					organizationId: "org-1",
				},
			],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
		}),
	)) as ConnectorSyncOutput;

	expect(output.success).toBe(false);
	expect(output.error).toContain("Reconnect your GitLab account");
	// Stopped at the first resource, not retried, nothing finalised.
	expect(mocks.fetchResourceDocuments).toHaveBeenCalledTimes(1);
	expect(mocks.garbageCollect).not.toHaveBeenCalled();
	expect(mocks.saveSyncCursor).not.toHaveBeenCalled();
	expect(mocks.scheduleNextSync).not.toHaveBeenCalled();
	expect(mocks.updateConnectorStatus).toHaveBeenCalledTimes(1);
	expect(mocks.updateConnectorStatus).toHaveBeenCalledWith(
		expect.objectContaining({ status: "ERROR" }),
	);
	expect(mocks.updateSyncJobActivity).toHaveBeenLastCalledWith(
		expect.objectContaining({ status: "FAILED" }),
	);
});

it("records GitLab's reason when one project refuses access, and carries on", async () => {
	// `/user` passes; one project's issues answer 403, everything else is empty.
	global.fetch = vi.fn(async (url: string | URL | Request) => {
		const href = String(url);
		if (href.endsWith("/api/v4/user")) {
			return json(200, { id: 1 });
		}
		if (href.includes("/projects/a%2Fb/issues")) {
			return json(403, { message: "403 Forbidden" });
		}
		return json(200, []);
	}) as typeof fetch;

	const mocks = {
		updateSyncJobActivity: vi.fn(async () => {}),
		loadConnectorConfig: vi.fn(async () => ({
			id: "conn-1",
			provider: "GITLAB",
			name: "GitLab",
			status: "CONNECTED",
			credentials: {},
			providerConfig: { projects: ["a/b", "c/d"] },
			syncConfig: {},
			lastSyncAt: null,
		})),
		testConnection: vi.fn(testConnection),
		discoverResources: vi.fn(discoverResources),
		fetchResourceDocuments: vi.fn(fetchResourceDocuments),
		loadSyncCursor: vi.fn(async () => undefined),
		storeDocuments: vi.fn(async () => ({ added: 0, updated: 0 })),
		generateEmbeddings: vi.fn(async () => ({ created: 0, updated: 0 })),
		garbageCollect: vi.fn(async () => ({ deleted: 0, vectorsDeleted: 0 })),
		saveSyncCursor: vi.fn(async () => {}),
		updateConnectorStatus: vi.fn(async () => {}),
		scheduleNextSync: vi.fn(async () => {}),
	};

	const taskQueue = "connector-sync-gitlab-forbidden";
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: mocks,
	});
	const output = (await worker.runUntil(
		env.client.workflow.execute("connectorSyncWorkflow", {
			args: [
				{
					syncJobId: "job-2",
					connectorId: "conn-1",
					provider: "GITLAB",
					syncType: "full",
					userId: "user-1",
					organizationId: "org-1",
				},
			],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
		}),
	)) as ConnectorSyncOutput;

	expect(output.success).toBe(true);
	expect(mocks.fetchResourceDocuments).toHaveBeenCalledTimes(2);
	expect(mocks.updateSyncJobActivity).toHaveBeenLastCalledWith(
		expect.objectContaining({
			status: "COMPLETED",
			failedItems: 1,
			stats: expect.objectContaining({
				errors: [
					expect.objectContaining({
						error: expect.stringContaining(
							"Your GitLab account cannot read",
						),
					}),
				],
			}),
		}),
	);
});
