import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * write_document_local argument validation: a document that is not a
 * non-empty markdown string must take the corrective retry instead of being
 * stored as the features document.
 */

const invokeMock = vi.fn();

vi.mock("../utils", async (importOriginal) => {
	const actual = (await importOriginal<
		typeof import("../utils")
	>()) as Record<string, unknown>;
	return {
		...actual,
		getAgentModel: vi.fn(() => ({
			invoke: invokeMock,
			bindTools: vi.fn(() => ({ invoke: invokeMock })),
		})),
	};
});

const { breakdownNode } = await import("../nodes/breakdown-node");

const baseState = {
	projectName: "Test Project",
	projectDescription: undefined,
	prdContent: "A short PRD describing a simple feature.",
	systemPrompt: undefined,
	tools: [],
	document: undefined,
	focusAnchor: undefined,
	error: undefined,
	retryCount: 0,
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
	const command = await breakdownNode({
		...baseState,
		messages: [new HumanMessage("Break it down")] as never,
	});
	const goto = (command as { goto?: string | string[] }).goto;
	return {
		goto: Array.isArray(goto) ? goto[0] : goto,
		update: (command as { update: Record<string, unknown> }).update,
	};
}

describe("story-breakdown breakdownNode — write_document_local arguments", () => {
	beforeEach(() => {
		invokeMock.mockReset();
	});

	it.each([
		["an object", { features: [{ title: "Login" }] }],
		["an array", ["# Features"]],
	])(
		"retries with a corrective message when document is %s",
		async (_label, document) => {
			const { goto, update } = await run({ document });

			expect(goto).toBe("breakdown");
			expect(update.retryCount).toBe(1);
			expect(update).not.toHaveProperty("document");
			const messages = update.messages as Array<{ content: unknown }>;
			expect(String(messages.at(-1)?.content)).toContain(
				"empty or invalid arguments",
			);
		},
	);

	it("stores a markdown string document as the features document", async () => {
		const { goto, update } = await run({
			document: "# Features\n\n- Login",
		});

		expect(goto).toBe("__end__");
		expect(update.document).toBe("# Features\n\n- Login");
		expect(update.retryCount).toBe(0);
	});
});
