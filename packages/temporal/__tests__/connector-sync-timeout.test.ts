import {
	ActivityFailure,
	ApplicationFailure,
	RetryState,
	TimeoutFailure,
	TimeoutType,
} from "@temporalio/common";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	activities: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@temporalio/workflow", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/workflow")>()),
	proxyActivities: () =>
		new Proxy(
			{},
			{
				get:
					(_target, name: string) =>
					(...args: unknown[]) =>
						(
							mocks.activities[name] as (
								...args: unknown[]
							) => unknown
						)?.(...args),
			},
		),
	setHandler: () => {},
	log: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { connectorSyncWorkflow } from "../src/workflows/connector-sync";

beforeEach(() => {
	mocks.activities = {
		loadConnectorConfig: vi.fn(async () => ({ syncConfig: {} })),
		testConnection: vi.fn(async () => true),
		discoverResources: vi.fn(async () => [
			{ id: "one", name: "one", type: "t" },
			{ id: "two", name: "two", type: "t" },
		]),
		loadSyncCursor: vi.fn(async () => undefined),
		fetchResourceDocuments: vi.fn(async () => {
			throw new ActivityFailure(
				"Activity task failed",
				"fetchResourceDocuments",
				"id",
				RetryState.TIMEOUT,
				undefined,
				new TimeoutFailure(
					"timed out",
					undefined,
					TimeoutType.SCHEDULE_TO_START,
				),
			);
		}),
		updateConnectorStatus: vi.fn(async () => {}),
		updateSyncJobActivity: vi.fn(async () => {}),
		scheduleNextSync: vi.fn(async () => {}),
	};
});

it("stops on an activity schedule-to-start timeout and reports its cause", async () => {
	const result = await connectorSyncWorkflow({
		connectorId: "example-connection",
		organizationId: "example-org",
		userId: "example-user",
		provider: "NOTION",
		syncType: "full",
	});
	expect(result).toMatchObject({
		success: false,
		error: "Connector sync activity did not start before the task queue timeout.",
	});
	expect(mocks.activities.fetchResourceDocuments).toHaveBeenCalledTimes(1);
	expect(mocks.activities.updateConnectorStatus).toHaveBeenCalledWith(
		expect.objectContaining({ status: "ERROR", lastError: result.error }),
	);
});

it("records a credential echo refusal and continues to the next resource", async () => {
	const message =
		"The resource was skipped because its content contains the connection's credential.";
	mocks.activities.fetchResourceDocuments = vi
		.fn()
		.mockRejectedValueOnce(
			new ActivityFailure(
				"Activity task failed",
				"fetchResourceDocuments",
				"id",
				RetryState.NON_RETRYABLE_FAILURE,
				undefined,
				ApplicationFailure.nonRetryable(
					message,
					"CONNECTOR_SYNC_PROVIDER_RETURNED_CREDENTIAL",
				),
			),
		)
		.mockResolvedValueOnce({ documents: [] });
	const result = await connectorSyncWorkflow({
		connectorId: "example-connection",
		organizationId: "example-org",
		userId: "example-user",
		provider: "NOTION",
		syncType: "full",
		syncJobId: "example-job",
	});
	expect(result.success).toBe(true);
	expect(mocks.activities.fetchResourceDocuments).toHaveBeenCalledTimes(2);
	expect(mocks.activities.updateSyncJobActivity).toHaveBeenLastCalledWith(
		expect.objectContaining({
			stats: expect.objectContaining({
				errors: [
					expect.objectContaining({
						resource: "one",
						error: message,
					}),
				],
			}),
		}),
	);
});
