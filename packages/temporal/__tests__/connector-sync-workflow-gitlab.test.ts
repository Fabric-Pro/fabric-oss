/**
 * Behavioral (TestWorkflowEnvironment) tests for the connector-sync
 * workflows' GitLab handling: the acting person is handed to every GitLab
 * activity, a connection or address failure stops the sync with its own
 * message, and the scheduled workflow refuses GitLab. Non-GitLab providers
 * keep `continueOnError`.
 *
 * Bundles the REAL workflow code and injects mocked activities. The
 * time-skipping test server is downloaded on first use (see
 * project-instruction-snapshot-workflow.test.ts for the offline note).
 */

import { resolve } from "node:path";
import { ApplicationFailure, WorkflowFailedError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type ConnectorSyncOutput,
	GITLAB_SYNC_CONNECTION_REQUIRED,
	GITLAB_SYNC_ORIGIN_MISMATCH,
} from "../src/workflows/connector-sync/types";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

type Activity = (input: any) => Promise<unknown>;

function activities(
	provider: string,
	overrides: Record<string, Activity> = {},
) {
	const mocks: Record<string, ReturnType<typeof vi.fn>> = {
		updateSyncJobActivity: vi.fn(async () => {}),
		loadConnectorConfig: vi.fn(async () => ({
			id: "conn-1",
			provider,
			name: "c",
			status: "CONNECTED",
			credentials: {},
			providerConfig: {},
			syncConfig: { incrementalSyncIntervalMinutes: 60 },
			lastSyncAt: null,
		})),
		testConnection: vi.fn(async () => true),
		discoverResources: vi.fn(async () => [
			{ id: "r1", name: "r1", type: "t" },
			{ id: "r2", name: "r2", type: "t" },
		]),
		loadSyncCursor: vi.fn(async () => undefined),
		fetchResourceDocuments: vi.fn(async (input: any) => ({
			documents: [
				{
					id: `${input.resource.id}-d`,
					externalId: `${input.resource.id}-d`,
					title: "t",
					content: "c",
					metadata: {},
				},
			],
		})),
		storeDocuments: vi.fn(async () => ({ added: 1, updated: 0 })),
		generateEmbeddings: vi.fn(async () => ({ created: 1, updated: 0 })),
		garbageCollect: vi.fn(async () => ({ deleted: 0, vectorsDeleted: 0 })),
		saveSyncCursor: vi.fn(async () => {}),
		updateConnectorStatus: vi.fn(async () => {}),
		scheduleNextSync: vi.fn(async () => {}),
	};
	for (const [name, impl] of Object.entries(overrides)) {
		mocks[name] = vi.fn(impl);
	}
	return mocks;
}

let seq = 0;

async function runSync(
	provider: string,
	mocks: Record<string, ReturnType<typeof vi.fn>>,
	syncType: "full" | "incremental" | "gc" = "full",
): Promise<ConnectorSyncOutput> {
	const taskQueue = `connector-sync-gitlab-${seq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: mocks,
	});
	return worker.runUntil(
		env.client.workflow.execute("connectorSyncWorkflow", {
			args: [
				{
					syncJobId: "job-1",
					connectorId: "conn-1",
					provider,
					syncType,
					userId: "user-1",
					organizationId: "org-1",
				},
			],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
		}),
	) as Promise<ConnectorSyncOutput>;
}

/** A `loadConnectorConfig` result recorded before GitLab stopped holding tokens. */
const LEGACY_CREDENTIALS = {
	accessToken: "legacy-access-token",
	refreshToken: "legacy-refresh-token",
	apiKey: "legacy-api-key",
};

function legacyConfig(provider: string) {
	return async () => ({
		id: "conn-1",
		provider,
		name: "c",
		status: "CONNECTED",
		credentials: LEGACY_CREDENTIALS,
		providerConfig: {},
		syncConfig: { incrementalSyncIntervalMinutes: 60 },
		lastSyncAt: null,
	});
}

const CREDENTIAL_ACTIVITIES = [
	"testConnection",
	"discoverResources",
	"fetchResourceDocuments",
	"garbageCollect",
];

describe("connectorSyncWorkflow — a legacy token in a loaded config", () => {
	it("is never handed to a GitLab activity", async () => {
		const mocks = activities("GITLAB", {
			loadConnectorConfig: legacyConfig("GITLAB"),
		});

		const output = await runSync("GITLAB", mocks, "gc");

		expect(output.success).toBe(true);
		for (const name of CREDENTIAL_ACTIVITIES) {
			expect(mocks[name]).toHaveBeenCalled();
			for (const [input] of mocks[name]!.mock.calls) {
				expect(input.credentials).toEqual({});
				const serialized = JSON.stringify(input);
				for (const secret of Object.values(LEGACY_CREDENTIALS)) {
					expect(serialized).not.toContain(secret);
				}
			}
		}
	});

	it("is still handed to other providers' activities", async () => {
		const mocks = activities("GITHUB", {
			loadConnectorConfig: legacyConfig("GITHUB"),
		});

		await runSync("GITHUB", mocks, "gc");

		for (const name of CREDENTIAL_ACTIVITIES) {
			for (const [input] of mocks[name]!.mock.calls) {
				expect(input.credentials).toEqual(LEGACY_CREDENTIALS);
			}
		}
	});
});

describe("connectorSyncWorkflow — GitLab", () => {
	it("hands the acting person to every GitLab activity that reads the provider", async () => {
		const mocks = activities("GITLAB");

		const output = await runSync("GITLAB", mocks);

		expect(output.success).toBe(true);
		for (const name of [
			"testConnection",
			"discoverResources",
			"fetchResourceDocuments",
		]) {
			for (const [input] of mocks[name]!.mock.calls) {
				expect(input).toMatchObject({
					userId: "user-1",
					organizationId: "org-1",
				});
			}
		}
		expect(mocks.fetchResourceDocuments).toHaveBeenCalledTimes(2);
	});

	it("ends in ERROR with the connection message when the person has no GitLab connection", async () => {
		const message =
			"Connect your GitLab account to sync this connection (GitLab is not connected).";
		const mocks = activities("GITLAB", {
			testConnection: async () => {
				throw ApplicationFailure.nonRetryable(
					message,
					GITLAB_SYNC_CONNECTION_REQUIRED,
				);
			},
		});

		const output = await runSync("GITLAB", mocks);

		expect(output.success).toBe(false);
		expect(output.error).toBe(message);
		expect(mocks.testConnection).toHaveBeenCalledTimes(1); // not retried
		expect(mocks.discoverResources).not.toHaveBeenCalled();
		expect(mocks.garbageCollect).not.toHaveBeenCalled();
		expect(mocks.updateConnectorStatus).toHaveBeenCalledWith(
			expect.objectContaining({ status: "ERROR", lastError: message }),
		);
		expect(mocks.updateSyncJobActivity).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: "FAILED", error: message }),
		);
	});

	it("stops at the first resource on an address refusal instead of continuing", async () => {
		const message = "This connection's GitLab address is refused.";
		const mocks = activities("GITLAB", {
			fetchResourceDocuments: async () => {
				throw ApplicationFailure.nonRetryable(
					message,
					GITLAB_SYNC_ORIGIN_MISMATCH,
				);
			},
		});

		const output = await runSync("GITLAB", mocks);

		expect(output.success).toBe(false);
		expect(output.error).toBe(message);
		expect(mocks.fetchResourceDocuments).toHaveBeenCalledTimes(1);
		expect(mocks.storeDocuments).not.toHaveBeenCalled();
		expect(mocks.updateConnectorStatus).toHaveBeenCalledWith(
			expect.objectContaining({ status: "ERROR", lastError: message }),
		);
	});
});

describe("connectorSyncWorkflow — other providers keep continueOnError", () => {
	it("records a failed resource and goes on to the next one", async () => {
		const mocks = activities("GITHUB", {
			fetchResourceDocuments: async (input: any) => {
				if (input.resource.id === "r1") {
					throw ApplicationFailure.nonRetryable(
						"boom",
						"SomeFailure",
					);
				}
				return { documents: [] };
			},
		});

		const output = await runSync("GITHUB", mocks);

		expect(output.success).toBe(true);
		expect(mocks.fetchResourceDocuments).toHaveBeenCalledTimes(2);
		expect(mocks.updateConnectorStatus).toHaveBeenCalledWith(
			expect.objectContaining({ status: "ACTIVE" }),
		);
	});

	it("keeps the generic failure message for a non-GitLab activity failure", async () => {
		const mocks = activities("GITHUB", {
			testConnection: async () => {
				throw ApplicationFailure.nonRetryable(
					"provider said no",
					GITLAB_SYNC_CONNECTION_REQUIRED.replace("GitLab", "Other"),
				);
			},
		});

		const output = await runSync("GITHUB", mocks);

		expect(output.success).toBe(false);
		expect(output.error).toBe("Activity task failed");
	});
});

describe("connectorScheduledSyncWorkflow", () => {
	const scheduledInput = (provider: string) => ({
		connectorId: "conn-1",
		provider,
		userId: "user-1",
		organizationId: "org-1",
		fullSyncIntervalHours: 24,
		incrementalSyncIntervalMinutes: 60,
		gcIntervalHours: 24,
	});

	it("refuses a GitLab connection without running any sync", async () => {
		const taskQueue = `connector-scheduled-gitlab-${seq++}`;
		const mocks = activities("GITLAB");
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities: mocks,
		});

		const error = await worker.runUntil(
			env.client.workflow
				.execute("connectorScheduledSyncWorkflow", {
					args: [scheduledInput("GITLAB")],
					taskQueue,
					workflowId: `${taskQueue}-wf`,
				})
				.then(
					() => null,
					(e: unknown) => e,
				),
		);

		expect(error).toBeInstanceOf(WorkflowFailedError);
		const cause = (error as WorkflowFailedError).cause;
		expect(cause).toBeInstanceOf(ApplicationFailure);
		expect((cause as ApplicationFailure).type).toBe(
			GITLAB_SYNC_CONNECTION_REQUIRED,
		);
		for (const mock of Object.values(mocks)) {
			expect(mock).not.toHaveBeenCalled();
		}
	});

	it("still runs other providers", async () => {
		const taskQueue = `connector-scheduled-github-${seq++}`;
		const mocks = activities("GITHUB");
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities: mocks,
		});

		await worker.runUntil(async () => {
			const handle = await env.client.workflow.start(
				"connectorScheduledSyncWorkflow",
				{
					args: [scheduledInput("GITHUB")],
					taskQueue,
					workflowId: `${taskQueue}-wf`,
				},
			);
			await env.sleep("90 minutes");
			await handle.terminate("test done");
		});

		expect(mocks.loadConnectorConfig).toHaveBeenCalled();
		expect(mocks.fetchResourceDocuments).toHaveBeenCalled();
	});
});
