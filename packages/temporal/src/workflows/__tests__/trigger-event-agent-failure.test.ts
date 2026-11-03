import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	loadTriggerConfig: vi.fn(),
	transformInput: vi.fn(),
	invokeAgent: vi.fn(),
	transformOutput: vi.fn(),
	sendWebhook: vi.fn(),
	sendEmail: vi.fn(),
	postToSlack: vi.fn(),
	storeResult: vi.fn(),
	updateTriggerStats: vi.fn(),
	patched: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: () => stubs,
	defineSignal: (name: string) => name,
	defineQuery: (name: string) => name,
	setHandler: vi.fn(),
	patched: stubs.patched,
	ApplicationFailure: class ApplicationFailure extends Error {
		static nonRetryable(message: string, type: string) {
			return Object.assign(new ApplicationFailure(message), {
				type,
				nonRetryable: true,
			});
		}
	},
	log: stubs.log,
}));

import { triggerEventWorkflow } from "../trigger-system/index";
import type { TriggerWorkflowInput } from "../trigger-system/types";

const INPUT: TriggerWorkflowInput = {
	triggerId: "trigger1",
	userId: "user1",
	organizationId: "org1",
	event: {
		id: "event1",
		triggerId: "trigger1",
		triggerType: "WEBHOOK",
		rawInput: {},
		message: "Please help",
		context: { sourceId: "source1", metadata: {} },
		receivedAt: new Date("2026-10-01T00:00:00Z"),
		status: "pending",
	},
};

beforeEach(() => {
	vi.resetAllMocks();
	stubs.patched.mockReturnValue(true);
	stubs.loadTriggerConfig.mockResolvedValue({
		id: "trigger1",
		status: "ACTIVE",
		agentId: "agent1",
		agentName: "Example agent",
		inputTemplate: "{{message}}",
		outputConfig: {
			outputTemplate: "{{response}}",
			webhookUrl: "https://example.com/webhook",
			emailTo: ["dev@example.com"],
			slackChannel: "channel1",
			storeResults: true,
		},
	});
	stubs.transformInput.mockResolvedValue("Please help");
	stubs.transformOutput.mockImplementation(async ({ response }) => response);
});

function expectOutputs(response: string) {
	expect(stubs.transformOutput).toHaveBeenCalledExactlyOnceWith({
		template: "{{response}}",
		response,
		event: INPUT.event,
	});
	expect(stubs.sendWebhook).toHaveBeenCalledExactlyOnceWith({
		url: "https://example.com/webhook",
		payload: { eventId: "event1", response },
	});
	expect(stubs.sendEmail).toHaveBeenCalledExactlyOnceWith({
		to: ["dev@example.com"],
		subject: "Agent Response: Example agent",
		body: response,
	});
	expect(stubs.postToSlack).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			channel: "channel1",
			message: response,
			organizationId: "org1",
		}),
	);
	expect(stubs.storeResult).toHaveBeenCalledExactlyOnceWith({
		triggerId: "trigger1",
		eventId: "event1",
		response,
		userId: "user1",
		organizationId: "org1",
	});
}

describe("trigger event agent failure", () => {
	it.each([
		{
			error: "Example provider failure",
			expected: "Example provider failure",
		},
		{ error: undefined, expected: "Agent invocation failed" },
		{ error: "", expected: "Agent invocation failed" },
	])(
		"rejects without output when the activity error is $error",
		async ({ error, expected }) => {
			stubs.invokeAgent.mockResolvedValue({
				success: false,
				response: "",
				...(error === undefined ? {} : { error }),
			});

			await expect(triggerEventWorkflow(INPUT)).rejects.toMatchObject({
				message: expected,
				type: "TRIGGER_SYSTEM_FAILED",
				nonRetryable: true,
			});

			for (const output of [
				stubs.transformOutput,
				stubs.sendWebhook,
				stubs.sendEmail,
				stubs.postToSlack,
				stubs.storeResult,
			]) {
				expect(output).not.toHaveBeenCalled();
			}
			expect(stubs.updateTriggerStats).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					success: false,
					error: expected,
					organizationId: "org1",
				}),
			);
			expect(stubs.patched).toHaveBeenCalledExactlyOnceWith(
				"trigger-event-agent-failure-2026-10",
			);
		},
	);

	it("sends successful output and records success without the failure marker", async () => {
		stubs.invokeAgent.mockResolvedValue({
			success: true,
			response: "Example response",
		});

		await expect(triggerEventWorkflow(INPUT)).resolves.toMatchObject({
			success: true,
			response: "Example response",
		});
		expectOutputs("Example response");
		expect(stubs.updateTriggerStats).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ success: true, organizationId: "org1" }),
		);
		expect(stubs.patched).toHaveBeenCalledExactlyOnceWith(
			"trigger-stats-delivery-outcome-2026-11",
		);
	});

	it("preserves failed invocation output and success stats for old histories", async () => {
		stubs.patched.mockReturnValue(false);
		stubs.invokeAgent.mockResolvedValue({
			success: false,
			response: "",
			error: "Example provider failure",
		});

		await expect(triggerEventWorkflow(INPUT)).resolves.toMatchObject({
			success: true,
			response: "",
		});
		expectOutputs("");
		expect(stubs.updateTriggerStats).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ success: true, organizationId: "org1" }),
		);
		expect(stubs.patched.mock.calls).toEqual([
			["trigger-event-agent-failure-2026-10"],
			["trigger-stats-delivery-outcome-2026-11"],
		]);
	});
});

describe("trigger event reply delivery in trigger stats", () => {
	const FAILED_POST = { success: false, error: "not_in_channel" };

	beforeEach(() => {
		stubs.invokeAgent.mockResolvedValue({
			success: true,
			response: "Example response",
			executionId: "execution1",
		});
		stubs.postToSlack.mockResolvedValue(FAILED_POST);
	});

	it("fails the run with the post's error when the Slack reply was not delivered", async () => {
		await expect(triggerEventWorkflow(INPUT)).resolves.toEqual({
			eventId: "event1",
			triggerId: "trigger1",
			success: false,
			error: "not_in_channel",
			agentExecutionId: "execution1",
			response: "Example response",
			durationMs: expect.any(Number),
		});

		expect(stubs.log.info).not.toHaveBeenCalledWith(
			"Trigger event processed successfully",
			expect.anything(),
		);
		expect(stubs.log.error).toHaveBeenCalledWith(
			"Trigger event reply was not delivered",
			expect.objectContaining({
				eventId: "event1",
				agentExecutionId: "execution1",
				error: "not_in_channel",
			}),
		);
		expect(stubs.updateTriggerStats).toHaveBeenCalledExactlyOnceWith({
			triggerId: "trigger1",
			lastTriggeredAt: expect.any(String),
			success: true,
			delivery: { success: false, error: "not_in_channel" },
			userId: "user1",
			organizationId: "org1",
		});
		expect(stubs.patched).toHaveBeenCalledWith(
			"trigger-stats-delivery-outcome-2026-11",
		);
	});

	it("succeeds when the Read-only gate skipped the Slack reply", async () => {
		stubs.postToSlack.mockResolvedValue({ success: true, skipped: true });

		await expect(triggerEventWorkflow(INPUT)).resolves.toEqual({
			eventId: "event1",
			triggerId: "trigger1",
			success: true,
			agentExecutionId: "execution1",
			response: "Example response",
			durationMs: expect.any(Number),
		});
		expect(stubs.log.info).toHaveBeenCalledWith(
			"Trigger event processed successfully",
			expect.objectContaining({ eventId: "event1" }),
		);
	});

	it("calls the stats exactly as before for histories without the delivery marker", async () => {
		stubs.patched.mockImplementation(
			(id: string) => id !== "trigger-stats-delivery-outcome-2026-11",
		);

		await expect(triggerEventWorkflow(INPUT)).resolves.toEqual({
			eventId: "event1",
			triggerId: "trigger1",
			success: true,
			agentExecutionId: "execution1",
			response: "Example response",
			durationMs: expect.any(Number),
		});
		expect(stubs.log.info).toHaveBeenCalledWith(
			"Trigger event processed successfully",
			expect.objectContaining({ eventId: "event1" }),
		);
		expect(stubs.log.error).not.toHaveBeenCalled();

		expect(stubs.updateTriggerStats).toHaveBeenCalledTimes(1);
		const stats = stubs.updateTriggerStats.mock.calls[0][0];
		expect(Object.keys(stats).sort()).toEqual([
			"lastTriggeredAt",
			"organizationId",
			"success",
			"triggerId",
			"userId",
		]);
		expect(stats).toMatchObject({
			triggerId: "trigger1",
			success: true,
			userId: "user1",
			organizationId: "org1",
		});
		expect(stubs.patched).toHaveBeenCalledWith(
			"trigger-stats-delivery-outcome-2026-11",
		);
	});
});
