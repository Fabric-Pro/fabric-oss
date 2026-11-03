import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testing } from "@/lib/agent/graph";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	original: { id: "example-original" },
	served: vi.fn(),
}));
vi.mock("@repo/agent-core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/agent-core")>()),
	getAgentModelAsync: async () => ({
		...mocks.original,
		invoke: mocks.invoke,
		bindTools: () => ({ invoke: mocks.invoke }),
	}),
	servedModelIdentity: mocks.served,
	logAgentUsageFromRunnableConfig: vi.fn(),
}));

const state = {
	messages: [new HumanMessage("Analyze examples")],
	systemPrompt: "Analyze data",
	response: "",
	error: null,
	mcpTools: [],
	chartArtifacts: [],
	connectionSuggestions: [],
	availableDataSources: [],
	reasoningByTurn: {},
	answerModel: null,
};
beforeEach(() => vi.resetAllMocks());

describe("Data Analyst served-model producer", () => {
	it("uses the original successful model instance rather than the tools wrapper or request hint", async () => {
		mocks.invoke.mockResolvedValue(new AIMessage("Answer"));
		mocks.served.mockReturnValue({
			model: "example-actual-served",
			provider: "OPENAI_DIRECT",
		});
		const output = await __testing.agentNode(
			{ ...state, mcpTools: [{ name: "example-tool" }] },
			{ configurable: { ai_model: "example-configured" } },
		);
		expect(output.answerModel).toEqual({
			id: "example-actual-served",
			provider: "OPENAI_DIRECT",
			viaPlan: false,
		});
		expect(mocks.served).toHaveBeenCalledWith(
			expect.objectContaining(mocks.original),
		);
	});
	it("does not borrow a prior successful identity for a failed static response", async () => {
		mocks.invoke.mockRejectedValue(new Error("Example provider failure"));
		const output = await __testing.agentNode({
			...state,
			answerModel: { id: "example-previous", viaPlan: true },
		});
		expect(output.answerModel).toBeNull();
		expect(mocks.served).not.toHaveBeenCalled();
	});
	it("keeps unknown successful instances unlabeled", async () => {
		mocks.invoke.mockResolvedValue(new AIMessage("Answer"));
		const output = await __testing.agentNode(state);
		expect(output.answerModel).toBeNull();
	});
});
