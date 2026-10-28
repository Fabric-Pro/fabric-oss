import { describe, expect, it } from "vitest";
import { ChatStreamProtocolError } from "../chat-stream-protocol";
import {
	limitSchema,
	parseWorkflowConfirmation,
} from "../direct-stream-protocol";
import {
	encodeOrchestratorStreamEvent,
	parseOrchestratorStreamEvent,
	parseResearchStreamEvent,
	toTaskPlan,
} from "../orchestrator-stream-protocol";

describe("orchestration stream contract", () => {
	it("round trips versioned approval and authentication context", () => {
		const event = {
			type: "approval_required",
			approvalId: "approval-1",
			stepId: "step-1",
			reason: "Create a document",
		} as const;
		expect(
			parseOrchestratorStreamEvent(
				JSON.parse(encodeOrchestratorStreamEvent(event).slice(6)),
			),
		).toEqual(event);
		expect(
			parseOrchestratorStreamEvent({
				type: "routing",
				primaryAgent: "agent-1",
				agentName: "Example",
				confidence: 1,
				requiredConnections: [
					{
						serverId: "server-1",
						serverName: "Example server",
						reason: "Search",
						authType: "OAUTH2",
						isSystemProvided: true,
						confidence: 1,
					},
				],
			}),
		).toMatchObject({ requiredConnections: [{ authType: "OAUTH2" }] });
	});
	it("rejects malformed nested events without including their values in errors", () => {
		expect(() =>
			parseOrchestratorStreamEvent({
				type: "completed",
				toolCalls: [{ name: { private: "example-secret" } }],
			}),
		).toThrow(ChatStreamProtocolError);
		try {
			parseOrchestratorStreamEvent({
				type: "approval_required",
				stepId: 12,
				reason: "example-secret",
			});
		} catch (error) {
			expect(String(error)).not.toContain("example-secret");
		}
	});
	it("distinguishes a transport timeout from completion", () => {
		expect(
			parseOrchestratorStreamEvent({
				type: "stream_timeout",
				executionId: "execution-1",
			}),
		).toMatchObject({ type: "stream_timeout" });
		expect(() =>
			parseOrchestratorStreamEvent({ type: "completed", version: 2 }),
		).toThrow("unsupported version");
		expect(
			parseOrchestratorStreamEvent({ type: "future", version: 1 }),
		).toBeNull();
	});
	it("preserves dependency and execution metadata while adapting legacy plans", () => {
		const event = parseOrchestratorStreamEvent({
			type: "planning",
			plan: {
				id: "plan-1",
				description: "Plan",
				riskLevel: "low",
				metadata: { isReadOnly: true },
				steps: [
					{
						id: "step-1",
						description: "Search",
						order: 1,
						dependsOn: ["step-0"],
						executor: "agent-1",
					},
				],
			},
		});
		if (event?.type !== "planning") {
			throw new Error("Expected plan");
		}
		expect(toTaskPlan(event.plan)).toMatchObject({
			strategy: "agent",
			metadata: { isReadOnly: true },
			steps: [
				{
					type: "agent",
					status: "pending",
					dependsOn: ["step-0"],
					executor: "agent-1",
				},
			],
		});
	});
});

describe("legacy workflow confirmation adapter", () => {
	const result = {
		requiresConfirmation: true,
		workflowId: "workflow-1",
		workflowName: "Example",
		message: "Execute?",
	};
	it("accepts only validated workflow execution results", () => {
		expect(
			parseWorkflowConfirmation("fabric_execute_workflow", result)
				?.workflowId,
		).toBe("workflow-1");
		expect(parseWorkflowConfirmation("search", result)).toBeUndefined();
		expect(
			parseWorkflowConfirmation("execute_workflow", {
				...result,
				workflowId: 123,
			}),
		).toBeUndefined();
		expect(
			parseWorkflowConfirmation("execute_workflow", {
				...result,
				requiresConfirmation: "true",
			}),
		).toBeUndefined();
	});
});

it.each(["subscription_exhausted", "subscription_reconnect"])(
	"accepts %s limit signals",
	(kind) => {
		const limit = { kind, message: "Example limit" };
		expect(limitSchema.parse(limit)).toEqual(limit);
		expect(
			parseOrchestratorStreamEvent({
				type: "limit_signal",
				signal: limit,
			}),
		).not.toBeNull();
	},
);

for (const read of [parseOrchestratorStreamEvent, parseResearchStreamEvent]) {
	it.each(["tool_start", "tool_input", "tool_result"])(
		"normalizes successful upstream %s",
		(type) => {
			expect(
				read({
					type,
					toolCallId: "example-tool",
					toolName: "search",
					status: "success",
					args: { query: "example" },
					result: { text: "example" },
				}),
			).toMatchObject({ type, status: "complete" });
		},
	);
}

it.each([parseOrchestratorStreamEvent, parseResearchStreamEvent])(
	"reads successful tools through the SSE transport",
	async (parse) => {
		const { readChatEventStream } = await import(
			"../read-chat-event-stream"
		);
		const events: unknown[] = [];
		const payloads = ["tool_start", "tool_input", "tool_result"].map(
			(type) => ({
				type,
				toolCallId: "example-tool",
				toolName: "search",
				status: "success",
				args: { query: "example" },
				...(type === "tool_result"
					? { result: { text: "example" }, durationMs: 12 }
					: {}),
			}),
		);
		const wire = [
			...payloads,
			{ type: "completed", status: "completed", response: "Example" },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		await readChatEventStream(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(wire));
					controller.close();
				},
			}),
			{
				parse,
				onEvent: (event) => events.push(event),
				isOutcome: (event) => event.type === "completed",
				isTerminal: (event) => event.type === "completed",
			},
		);
		expect(events.slice(0, 3)).toMatchObject(
			payloads
				.map(({ status, ...event }) => ({
					...event,
					status: "complete",
				}))
				.map(({ durationMs, ...event }, index) =>
					index === 2 ? { ...event, durationMs } : event,
				),
		);
	},
);
