import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * write_document_local argument validation: a document that is not a
 * non-empty markdown string must take the corrective retry instead of being
 * stored as the edit.
 */

const invokeMock = vi.fn();

vi.mock("../utils", async (importOriginal) => {
	const actual = (await importOriginal<
		typeof import("../utils")
	>()) as Record<string, unknown>;
	return {
		...actual,
		getAgentModelAsync: vi.fn(async () => ({
			invoke: invokeMock,
			bindTools: vi.fn(() => ({ invoke: invokeMock })),
		})),
	};
});

const { chatNode } = await import("../nodes/chat-node");

const baseState = {
	document: undefined,
	focusAnchor: undefined,
	documentType: "general" as const,
	projectContext: undefined,
	ragContexts: [],
	systemPrompt: undefined,
	error: undefined,
	retryCount: 0,
	tools: [],
	reasoningByTurn: {},
};

function writeDocumentCall(args: Record<string, unknown>) {
	return new AIMessage({
		content: "",
		tool_calls: [
			{
				id: "call_1",
				name: "write_document_local",
				args,
				type: "tool_call" as const,
			},
		],
	});
}

async function run(args: Record<string, unknown>) {
	invokeMock.mockResolvedValueOnce(writeDocumentCall(args));
	const command = await chatNode({
		...baseState,
		messages: [new HumanMessage("Draft a doc")] as never,
	});
	const goto = (command as { goto?: string | string[] }).goto;
	return {
		goto: Array.isArray(goto) ? goto[0] : goto,
		update: (command as { update: Record<string, unknown> }).update,
	};
}

describe("document-generator chatNode — write_document_local arguments", () => {
	beforeEach(() => {
		invokeMock.mockReset();
	});

	it.each([
		["an object", { title: "Spec", body: "# Spec" }],
		["an array", ["# Spec"]],
	])(
		"retries with a corrective message when document is %s",
		async (_label, document) => {
			const { goto, update } = await run({ document });

			expect(goto).toBe("chat_node");
			expect(update.retryCount).toBe(1);
			expect(update).not.toHaveProperty("document");
			const messages = update.messages as Array<{ content: unknown }>;
			expect(String(messages.at(-1)?.content)).toContain(
				"empty or invalid arguments",
			);
		},
	);

	it("stores a markdown string document as the edit", async () => {
		const { goto, update } = await run({ document: "# Spec\n\nBody" });

		expect(goto).toBe("__end__");
		expect(update.document).toBe("# Spec\n\nBody");
		expect(update.retryCount).toBe(0);
	});
});
