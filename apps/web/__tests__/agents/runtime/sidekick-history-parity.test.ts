// @vitest-environment node
/**
 * The Sidekick's history is the same on both transports: one scripted reply
 * (text and a `suggest_tools` call, then text; or text, a call, text and a
 * second call in one step, then text; or text and a call whose tool throws,
 * then text), produced by the real AI SDK
 * as the route's UI message stream into `useChat`'s message, and as the
 * runtime's AG-UI events into an agent's messages read back through
 * `sidekickUiMessages`, converts to the same model messages, which is what
 * the next turn sends the model.
 *
 * The one intended difference: reasoning, which the runtime does not carry.
 */
import { sidekickUiMessages } from "@saas/agents/lib/sidekick-runtime-protocol";
import { convertToModelMessages, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	failedToolSteps,
	interleavedSteps,
	scriptedReply,
	scriptedSteps,
} from "./_helpers/sidekick-history";

/** `messages` without their reasoning parts. */
function withoutReasoning(messages: ModelMessage[]): ModelMessage[] {
	return messages.map((message) =>
		message.role === "assistant" && Array.isArray(message.content)
			? {
					...message,
					content: message.content.filter(
						(part) => part.type !== "reasoning",
					),
				}
			: message,
	);
}

describe("Sidekick history across transports", () => {
	it("converts to the same model messages from the route's and the runtime's reply", async () => {
		const { reference, agUi } = await scriptedReply();

		const routeHistory = await convertToModelMessages(reference);
		const runtimeHistory = await convertToModelMessages(
			sidekickUiMessages(agUi),
		);

		expect(runtimeHistory).toEqual(routeHistory);
		// The comparison covers the turn's tool round, not only its text.
		expect(routeHistory.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		expect(JSON.stringify(routeHistory)).toContain("sidekick_apply_tools");
	});

	it("keeps text written after a tool call in its model step", async () => {
		const { reference, agUi } = await scriptedReply(interleavedSteps);

		const routeHistory = await convertToModelMessages(reference);
		const runtimeHistory = await convertToModelMessages(
			sidekickUiMessages(agUi),
		);

		expect(runtimeHistory).toEqual(routeHistory);
		// One assistant block holds both calls and the text between them.
		expect(routeHistory.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		expect(routeHistory[1]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "text", text: "Adding a tool." },
				{ type: "tool-call", toolCallId: "call-1" },
				{ type: "text", text: "And removing one." },
				{ type: "tool-call", toolCallId: "call-2" },
			],
		});
	});

	it("sends a tool that threw back as an error result, not a successful one", async () => {
		const { reference, agUi } = await scriptedReply(failedToolSteps);

		const routeHistory = await convertToModelMessages(reference);
		const runtimeHistory = await convertToModelMessages(
			sidekickUiMessages(agUi),
		);

		expect(runtimeHistory).toEqual(routeHistory);
		expect(routeHistory.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		expect(routeHistory[2]).toMatchObject({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-1",
					output: { type: "error-text" },
				},
			],
		});
	});

	it("differs only by the reasoning the runtime does not carry", async () => {
		const { reference, agUi } = await scriptedReply(() =>
			scriptedSteps({ reasoning: true }),
		);

		const routeHistory = await convertToModelMessages(reference);
		const runtimeHistory = await convertToModelMessages(
			sidekickUiMessages(agUi),
		);

		expect(JSON.stringify(routeHistory)).toContain(
			"Weighing the tools first.",
		);
		expect(runtimeHistory).not.toEqual(routeHistory);
		expect(runtimeHistory).toEqual(withoutReasoning(routeHistory));
	});
});
