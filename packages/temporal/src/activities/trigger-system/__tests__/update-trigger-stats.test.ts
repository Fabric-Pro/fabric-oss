/**
 * Trigger statistics record the reply's real delivery: a run whose Slack
 * reply post failed is a FAILED execution with the post's error, while a
 * deliberately skipped reply (Read-only project) still counts as success.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const triggerUpdate = vi.fn();
const triggerFindUnique = vi.fn();
const executionCreate = vi.fn();
vi.mock("@repo/database", () => ({
	resolveWorkflowIntegrationForProvider: vi.fn(),
	isProjectReadOnly: vi.fn(async () => false),
	hasProjectAccess: vi.fn(async () => true),
	db: {
		agentDeploymentTrigger: {
			update: (...a: unknown[]) => triggerUpdate(...a),
			findUnique: (...a: unknown[]) => triggerFindUnique(...a),
		},
		agentDeploymentExecution: {
			create: (...a: unknown[]) => executionCreate(...a),
		},
	},
}));
vi.mock("@repo/integrations/slack", () => ({ sendSlackMessage: vi.fn() }));
vi.mock("@repo/integrations", () => ({ channelRegistry: { get: vi.fn() } }));
vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../agentic-loop/in-flight-tool-compaction", () => ({
	makeInFlightToolCompactor: () => undefined,
}));

import { updateTriggerStats } from "../index";

const BASE = {
	triggerId: "trigger1",
	lastTriggeredAt: "2026-11-02T10:00:00.000Z",
	userId: "user1",
	organizationId: "org1",
};

beforeEach(() => {
	vi.clearAllMocks();
	triggerUpdate.mockResolvedValue({});
	triggerFindUnique.mockResolvedValue({
		deploymentId: "deployment1",
		type: "SLACK_MENTION",
	});
	executionCreate.mockResolvedValue({});
});

function storedExecution() {
	expect(executionCreate).toHaveBeenCalledTimes(1);
	return executionCreate.mock.calls[0][0].data;
}

describe("updateTriggerStats delivery outcome", () => {
	it("records a failed reply post as a FAILED execution with the post's error", async () => {
		await updateTriggerStats({
			...BASE,
			success: true,
			delivery: { success: false, error: "not_in_channel" },
		});

		expect(storedExecution()).toMatchObject({
			status: "FAILED",
			error: "not_in_channel",
			triggerId: "trigger1",
			organizationId: "org1",
			deployment: { connect: { id: "deployment1" } },
		});
	});

	it("records a skipped reply (Read-only project) as COMPLETED", async () => {
		await updateTriggerStats({
			...BASE,
			success: true,
			delivery: { success: true, skipped: true },
		});

		expect(storedExecution()).toMatchObject({
			status: "COMPLETED",
			error: null,
		});
	});

	it.each([
		{ success: true, error: undefined, status: "COMPLETED", stored: null },
		{
			success: false,
			error: "Example provider failure",
			status: "FAILED",
			stored: "Example provider failure",
		},
	])(
		"without a delivery, records success $success as $status",
		async ({ success, error, status, stored }) => {
			await updateTriggerStats({ ...BASE, success, error });

			expect(triggerUpdate).toHaveBeenCalledExactlyOnceWith({
				where: { id: "trigger1" },
				data: {
					lastRunAt: new Date("2026-11-02T10:00:00.000Z"),
					totalExecutions: { increment: 1 },
				},
			});
			expect(storedExecution()).toMatchObject({
				executionId: expect.stringMatching(/^trigger-trigger1-\d+$/),
				triggerType: "SLACK_MENTION",
				triggerId: "trigger1",
				status,
				error: stored,
				startedAt: new Date("2026-11-02T10:00:00.000Z"),
				userId: "user1",
				organizationId: "org1",
			});
		},
	);
});
