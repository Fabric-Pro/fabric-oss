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

	it("sends successful output and records success without a patch marker", async () => {
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
		expect(stubs.patched).not.toHaveBeenCalled();
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
		expect(stubs.patched).toHaveBeenCalledExactlyOnceWith(
			"trigger-event-agent-failure-2026-10",
		);
	});
});
