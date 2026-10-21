import { coerceMessageLikeToMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { extractState } from "../invoke-agent";
import { normalizeMessages } from "../normalize-messages";

describe("CopilotKit backlog history", () => {
	it.each(["toolCalls", "tool_calls"])(
		"preserves %s and function arguments",
		(field) => {
			const [raw] = normalizeMessages([
				{
					role: "assistant",
					id: "example-assistant",
					content: "",
					[field]: [
						{
							id: "example-call",
							function: {
								name: "analyze_backlog",
								arguments: '{"userPrompt":"Review"}',
							},
						},
					],
				},
			]);
			const message = coerceMessageLikeToMessage(raw) as any;
			expect(message.tool_calls).toEqual([
				{
					id: "example-call",
					name: "analyze_backlog",
					args: { userPrompt: "Review" },
					type: "tool_call",
				},
			]);
			expect(message.id).toBe("example-assistant");
		},
	);
	it("preserves result name, message id and call id", () => {
		const [message] = normalizeMessages([
			{
				type: "tool",
				id: "example-result",
				toolCallId: "example-call",
				name: "analyze_backlog",
				content: { complete: true },
			},
		]).map(coerceMessageLikeToMessage);
		expect(message).toMatchObject({
			id: "example-result",
			name: "analyze_backlog",
			tool_call_id: "example-call",
			content: '{"complete":true}',
		});
	});
	it("extracts integration and analysis state without turning false into fallback true", () => {
		expect(
			extractState({
				state: {
					hasSlackIntegration: false,
					analysisStatus: "complete",
					lastProposalSummary: "Ready",
				},
				forwardedProps: { hasSlackIntegration: true },
			}),
		).toMatchObject({
			hasSlackIntegration: false,
			analysisStatus: "complete",
			lastProposalSummary: "Ready",
		});
	});
});
