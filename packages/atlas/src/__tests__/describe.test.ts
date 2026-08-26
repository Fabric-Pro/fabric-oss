/**
 * `describeModules` — smart category assignment (B1), telemetry accumulation
 * across batches (T3), and authoritative-user-note feeding (B4).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateObject = vi.fn();
const mockGetModel = vi.fn();
const mockTrackUsage = vi.fn();
const mockLogUsage = vi.fn();

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
	generateObject: (...args: unknown[]) => mockGenerateObject(...args),
	getAIModelWithMetadata: (...args: unknown[]) => mockGetModel(...args),
	logModelUsageAsync: (...args: unknown[]) => mockLogUsage(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AIProviderNotConfiguredError } from "@repo/ai";
import { describeModules, type ModuleDescribeInput } from "../describe";

const ctx = { userId: "user-1", organizationId: "org-1" };

function makeModule(i: number): ModuleDescribeInput {
	return {
		key: `mod-${i}`,
		label: `Module ${i}`,
		path: `src/mod${i}`,
		language: "TypeScript",
		fileCount: 3,
		loc: 100,
		sampleFiles: [],
		dependsOn: [],
		dependedOnBy: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetModel.mockResolvedValue({
		model: { id: "m" },
		metadata: { canonicalName: "gpt-4o-mini" },
		trackUsage: mockTrackUsage,
	});
});

describe("describeModules — categories + telemetry", () => {
	it("persists the AI category (normalised to lowercase) and the resolved model", async () => {
		mockGenerateObject.mockResolvedValue({
			object: {
				descriptions: [
					{ technical: "t1", business: "b1", category: "AI" },
				],
			},
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		});

		const result = await describeModules([makeModule(1)], ctx, "p1");

		expect(result.descriptions).toEqual([
			{ key: "mod-1", technical: "t1", business: "b1", category: "ai" },
		]);
		expect(result.model).toBe("gpt-4o-mini");
	});

	it("accumulates token usage across multiple batches (7 modules → 2 batches)", async () => {
		// Batch 1: 6 modules; batch 2: 1 module. Each call reports 15 total.
		mockGenerateObject
			.mockResolvedValueOnce({
				object: {
					descriptions: Array.from({ length: 6 }, (_, j) => ({
						technical: `t${j}`,
						business: `b${j}`,
						category: "data",
					})),
				},
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			})
			.mockResolvedValueOnce({
				object: {
					descriptions: [
						{ technical: "t6", business: "b6", category: "ops" },
					],
				},
				usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
			});

		const modules = Array.from({ length: 7 }, (_, i) => makeModule(i));
		const result = await describeModules(modules, ctx, "p1");

		expect(mockGenerateObject).toHaveBeenCalledTimes(2);
		expect(result.descriptions).toHaveLength(7);
		// Summed across both batches: 10+8 prompt, 5+4 completion, 15+12 total.
		expect(result.usage).toEqual({
			promptTokens: 18,
			completionTokens: 9,
			totalTokens: 27,
		});
	});

	it("returns empty telemetry (model null) when no AI provider is configured", async () => {
		mockGetModel.mockRejectedValueOnce(
			new AIProviderNotConfiguredError("no provider"),
		);
		const result = await describeModules([makeModule(1)], ctx, "p1");
		expect(result.descriptions).toEqual([]);
		expect(result.model).toBeNull();
		expect(result.usage).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		});
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("feeds an authoritative user note into the prompt (B4)", async () => {
		mockGenerateObject.mockResolvedValue({
			object: {
				descriptions: [
					{ technical: "t", business: "b", category: "security" },
				],
			},
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});

		await describeModules(
			[
				{
					...makeModule(1),
					userNote: {
						description:
							"This is the auth gateway, treat as ground truth.",
						category: "security",
					},
				},
			],
			ctx,
			"p1",
		);

		const prompt = mockGenerateObject.mock.calls[0][0].prompt as string;
		expect(prompt).toContain("AUTHORITATIVE USER NOTES");
		expect(prompt).toContain(
			"This is the auth gateway, treat as ground truth.",
		);
	});
});

describe("describeModules — per-batch persistence (resumability)", () => {
	it("persists each batch as it completes (7 modules → 2 batches → 2 persist calls)", async () => {
		mockGenerateObject
			.mockResolvedValueOnce({
				object: {
					descriptions: Array.from({ length: 6 }, (_, j) => ({
						technical: `t${j}`,
						business: `b${j}`,
						category: "data",
					})),
				},
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			})
			.mockResolvedValueOnce({
				object: {
					descriptions: [
						{ technical: "t6", business: "b6", category: "ops" },
					],
				},
				usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
			});

		const onBatch = vi.fn().mockResolvedValue(undefined);
		const modules = Array.from({ length: 7 }, (_, i) => makeModule(i));
		await describeModules(modules, ctx, "p1", undefined, onBatch);

		// One persist per AI batch — so a mid-run worker death only loses the
		// in-flight batch (≤6 modules), not every prior batch.
		expect(onBatch).toHaveBeenCalledTimes(2);
		expect(onBatch.mock.calls[0][0]).toHaveLength(6);
		expect(onBatch.mock.calls[1][0]).toEqual([
			{ key: "mod-6", technical: "t6", business: "b6", category: "ops" },
		]);
	});

	it("propagates a persistence failure (→ activity retry) instead of swallowing it as a describe failure", async () => {
		mockGenerateObject.mockResolvedValue({
			object: {
				descriptions: [
					{ technical: "t", business: "b", category: "data" },
				],
			},
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});
		const onBatch = vi.fn().mockRejectedValue(new Error("db down"));

		await expect(
			describeModules([makeModule(1)], ctx, "p1", undefined, onBatch),
		).rejects.toThrow("db down");
	});

	it("does not call the persist hook for a batch that yielded no descriptions", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { descriptions: [] },
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});
		const onBatch = vi.fn().mockResolvedValue(undefined);
		await describeModules([makeModule(1)], ctx, "p1", undefined, onBatch);
		expect(onBatch).not.toHaveBeenCalled();
	});
});
