import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	client: {
		getMemoryBlock: vi.fn(),
		getOrCreateMemoryBlock: vi.fn(),
		updateMemoryBlock: vi.fn(),
	},
	getLettaClient: vi.fn(),
	searchSimilarExecutions: vi.fn(),
}));
vi.mock("@repo/letta", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getLettaClient: h.getLettaClient,
}));
vi.mock("@repo/ai", () => ({ generateText: vi.fn() }));
vi.mock("../src/activities/orchestrator/utils/model-selector", () => ({
	getAiModel: vi.fn(),
}));
vi.mock("@repo/rag", () => ({
	generateEmbedding: vi.fn(async () => ({ embedding: [0.1], tokens: 1 })),
	executionExists: vi.fn(),
	storeExecutionSummary: vi.fn(),
	searchSimilarExecutions: h.searchSimilarExecutions,
}));

import { LettaError } from "@repo/letta";
import {
	getRoutingSuggestions,
	recordExecution,
} from "../src/activities/letta-memory-activities";
import { getHybridRoutingSuggestions } from "../src/activities/orchestrator-memory-activities";

const input = {
	lettaAgentId: "agent-example",
	executionId: "execution-example",
	task: "distinctive confidential launch request",
	steps: [
		{
			stepId: "step-a",
			description: "distinctive completed step",
			status: "complete" as const,
		},
		{
			stepId: "step-b",
			description: "distinctive failed step",
			status: "error" as const,
		},
	],
	success: true,
	durationMs: 12,
};
const labels = ["execution_history", "successful_patterns", "error_patterns"];

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("LETTA_BASE_URL", "https://memory.example.com");
	h.getLettaClient.mockReturnValue(h.client);
	h.client.getMemoryBlock.mockResolvedValue({ value: "[]" });
	h.client.getOrCreateMemoryBlock.mockResolvedValue({ value: "[]" });
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("organization Letta run text removal", () => {
	it.each([true, false])(
		"clears existing run blocks without writing input text (success=%s)",
		async (success) => {
			h.client.getMemoryBlock.mockResolvedValue({
				value: '{"legacy":"stored text"}',
			});
			await recordExecution({ ...input, success });
			const writes = JSON.stringify(
				h.client.updateMemoryBlock.mock.calls,
			);
			for (const text of [
				input.task,
				...input.steps.map((step) => step.description),
			]) {
				expect(writes).not.toContain(text);
			}
			expect(h.client.updateMemoryBlock.mock.calls).toEqual(
				labels.map((label) => [input.lettaAgentId, label, "[]"]),
			);
			expect(h.client.getOrCreateMemoryBlock).not.toHaveBeenCalled();
		},
	);

	it("skips empty and missing blocks while clearing a remaining block", async () => {
		h.client.getMemoryBlock.mockImplementation(async (_id, label) => {
			if (label === "execution_history") {
				return { value: "[]" };
			}
			if (label === "successful_patterns") {
				throw new LettaError("missing", "BLOCK_NOT_FOUND", 404);
			}
			return { value: "" };
		});
		await recordExecution(input);
		expect(h.client.updateMemoryBlock.mock.calls).toEqual([
			[input.lettaAgentId, "error_patterns", "[]"],
		]);
		expect(h.client.getOrCreateMemoryBlock).not.toHaveBeenCalled();
	});

	it("swallows block failures without logging provider or run text and attempts the other blocks", async () => {
		h.client.getMemoryBlock.mockRejectedValueOnce(new Error(input.task));
		h.client.getMemoryBlock.mockResolvedValue({ value: "legacy" });
		await expect(recordExecution(input)).resolves.toBeUndefined();
		expect(h.client.getMemoryBlock).toHaveBeenCalledTimes(3);
		expect(console.error).toHaveBeenCalled();
		expect(
			JSON.stringify(vi.mocked(console.error).mock.calls),
		).not.toContain(input.task);
		expect(h.client.updateMemoryBlock).toHaveBeenCalledTimes(2);
	});

	it("returns empty routing suggestions without acquiring a client or reading blocks", async () => {
		h.client.getMemoryBlock.mockResolvedValue({
			value: JSON.stringify([
				{ taskPattern: input.task, agents: ["agent-a"], usageCount: 2 },
			]),
		});
		await expect(getRoutingSuggestions(input)).resolves.toEqual([]);
		expect(h.getLettaClient).not.toHaveBeenCalled();
		expect(h.client.getMemoryBlock).not.toHaveBeenCalled();
	});

	it("keeps Qdrant results and failure warnings without consulting Letta", async () => {
		h.client.getMemoryBlock.mockResolvedValue({
			value: JSON.stringify([
				{
					taskPattern: input.task,
					agents: ["legacy-agent"],
					usageCount: 2,
				},
			]),
		});
		const execution = {
			id: "semantic-example",
			taskDescription: "semantic task",
			taskHash: "hash",
			summary: "failure: synthetic error.",
			agentsUsed: ["semantic-agent"],
			toolsUsed: ["example-tool"],
			outcome: "success",
			durationMs: 1,
			stepCount: 1,
			userId: "user-example",
			organizationId: "org-example",
			timestamp: new Date().toISOString(),
		};
		h.searchSimilarExecutions.mockResolvedValue([
			{ execution, similarity: 0.9 },
		]);
		const result = await getHybridRoutingSuggestions({
			task: input.task,
			lettaAgentId: input.lettaAgentId,
			userId: "user-example",
			organizationId: "org-example",
		});
		expect(
			result.suggestions.map((suggestion) => suggestion.source),
		).toEqual(["qdrant"]);
		expect(result.suggestions[0]).toMatchObject({
			agents: ["semantic-agent"],
			tools: ["example-tool"],
			pattern: "semantic task",
		});
		expect(result.warnings).toHaveLength(1);
		expect(result.stats).toEqual({
			lettaMatches: 0,
			semanticMatches: 1,
			failureMatches: 1,
		});
		expect(h.searchSimilarExecutions).toHaveBeenCalledTimes(2);
		expect(h.client.getMemoryBlock).not.toHaveBeenCalled();
	});
});
