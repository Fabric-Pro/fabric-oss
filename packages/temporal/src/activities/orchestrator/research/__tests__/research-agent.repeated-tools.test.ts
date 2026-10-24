import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock("@repo/ai", () => ({
	generateText: (...args: unknown[]) => mocks.generateText(...args),
	isStepCount: vi.fn(),
}));
vi.mock("../../utils", () => ({
	getAiModelWithSelection: async () => ({
		model: {},
		provider: "OPENAI",
		modelString: "example-model",
	}),
}));
vi.mock("../research-tools", () => ({
	buildResearchTools: async () => ({
		webSearch: { execute: async () => "example result" },
	}),
}));

import { executeResearchAgent } from "../research-agent";

it("isolates repeat notices per query while preserving execution output", async () => {
	const outputs: unknown[] = [];
	mocks.generateText.mockImplementation(async ({ tools }) => {
		for (const toolCallId of ["first", "second"]) {
			const input = { query: "example" };
			const output = await tools.webSearch.execute(input, { toolCallId });
			expect(output).toBe("example result");
			outputs.push(
				tools.webSearch.toModelOutput?.({
					input,
					output,
					toolCallId,
				}) ?? { type: "text", value: output },
			);
		}
		return { text: "done", steps: [] };
	});
	const result = await executeResearchAgent({
		researchQueries: ["query one", "query two"],
		informationNeeds: [],
		originalTask: "example task",
		userId: "example-user",
		organizationId: "example-org",
		availableTools: [],
		availableAgents: [],
	});
	expect(result).toHaveLength(2);
	expect(outputs[0]).toEqual({ type: "text", value: "example result" });
	expect(outputs[1]).toEqual({
		type: "text",
		value: expect.stringContaining("same result"),
	});
	expect(outputs[2]).toEqual(outputs[0]);
	expect(outputs[3]).toEqual(outputs[1]);
});

it("allows the same first call in two separate queries", async () => {
	const outputs: unknown[] = [];
	mocks.generateText.mockImplementation(async ({ tools }) => {
		const input = { query: "example" };
		const toolCallId = "first";
		const output = await tools.webSearch.execute(input, { toolCallId });
		outputs.push(
			tools.webSearch.toModelOutput?.({ input, output, toolCallId }) ?? {
				type: "text",
				value: output,
			},
		);
		return { text: "done", steps: [] };
	});
	await executeResearchAgent({
		researchQueries: ["query one", "query two"],
		informationNeeds: [],
		originalTask: "example task",
		userId: "example-user",
		organizationId: "example-org",
		availableTools: [],
		availableAgents: [],
	});
	expect(outputs).toEqual([
		{ type: "text", value: "example result" },
		{ type: "text", value: "example result" },
	]);
});
