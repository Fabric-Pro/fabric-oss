import { simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";

const { rows } = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock("@repo/database", () => ({ logAiUsageAsync: rows }));

import { AI_CALL_PURPOSES as P } from "../call-purpose";
import {
	currentAiCallPurpose,
	runWithAiCallPurpose,
} from "../call-purpose-context";
import {
	createEmbeddingUsageLoggingMiddleware,
	createUsageLoggingMiddleware,
	wrapEvaluationModelWithUsageLogging,
} from "../usage-logging-middleware";

const context = {
	provider: "VERCEL_GATEWAY" as const,
	providerModelId: "example-model",
	featureKey: "chat-agent",
	jobType: "scheduled-report",
	callPurpose: P.mainRound,
};
const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };

describe("usage-only call purpose scopes", () => {
	it("isolates concurrent scopes and restores the outer scope after rejection", async () => {
		expect(currentAiCallPurpose()).toBeUndefined();
		await runWithAiCallPurpose(P.mainRound, async () => {
			const seen = await Promise.all(
				[P.resultSummaryChunk, P.toolArgumentRepair].map((purpose) =>
					runWithAiCallPurpose(purpose, async () => {
						await Promise.resolve();
						return currentAiCallPurpose();
					}),
				),
			);
			expect(seen).toEqual([
				"result-summary-chunk",
				"tool-argument-repair",
			]);
			await expect(
				runWithAiCallPurpose(P.compaction, async () => {
					throw new Error("example failure");
				}),
			).rejects.toThrow("example failure");
			expect(currentAiCallPurpose()).toBe("main-round");
		});
		expect(currentAiCallPurpose()).toBeUndefined();
	});

	it.each(["language generate", "language stream", "embedding", "decision"])(
		"fixed resolution purpose resists an unrelated scope for %s",
		async (kind) => {
			rows.mockClear();
			await runWithAiCallPurpose(P.compaction, async () => {
				if (kind === "language generate") {
					await (
						createUsageLoggingMiddleware(context) as any
					).wrapGenerate({ doGenerate: async () => ({ usage }) });
				} else if (kind === "language stream") {
					const result = await (
						createUsageLoggingMiddleware(context) as any
					).wrapStream({
						doStream: async () => ({
							stream: simulateReadableStream({
								chunks: [{ type: "finish", usage }],
							}),
						}),
					});
					for await (const _chunk of result.stream) {
					}
				} else if (kind === "embedding") {
					await (
						createEmbeddingUsageLoggingMiddleware(context) as any
					).wrapEmbed({
						doEmbed: async () => ({ usage: { tokens: 3 } }),
					});
				} else {
					await wrapEvaluationModelWithUsageLogging(
						{
							specificationVersion: "v1",
							provider: "example",
							modelId: "example-model",
							supportedQuestionTypes: ["boolean"],
							doDecide: async () => ({ usage }),
						} as any,
						context,
					).doDecide({} as any);
				}
			});
			expect(rows.mock.calls[0][0].callPurpose).toBe("main-round");
		},
	);

	it("snapshots the stream purpose before consumption outside its scope", async () => {
		rows.mockClear();
		const middleware = createUsageLoggingMiddleware({
			...context,
			callPurpose: undefined,
		}) as any;
		const result = await runWithAiCallPurpose(P.synthesis, () =>
			middleware.wrapStream({
				doStream: async () => ({
					stream: simulateReadableStream({
						chunks: [{ type: "finish", usage }],
					}),
				}),
			}),
		);
		await runWithAiCallPurpose(P.compaction, async () => {
			for await (const _chunk of result.stream) {
			}
		});
		expect(rows.mock.calls[0][0]).toMatchObject({
			callPurpose: "synthesis",
			featureKey: "chat-agent",
			jobType: "scheduled-report",
		});
	});

	it("attributes reused language models, embeddings and decision models at invocation", async () => {
		rows.mockClear();
		const language = createUsageLoggingMiddleware({
			...context,
			callPurpose: undefined,
		}) as any;
		await runWithAiCallPurpose(P.toolArgumentRepair, () =>
			language.wrapGenerate({ doGenerate: async () => ({ usage }) }),
		);
		const embedding = createEmbeddingUsageLoggingMiddleware({
			...context,
			callPurpose: undefined,
		}) as any;
		await runWithAiCallPurpose(P.trajectoryEmbedding, () =>
			embedding.wrapEmbed({
				doEmbed: async () => ({ usage: { tokens: 3 } }),
			}),
		);
		const decision = wrapEvaluationModelWithUsageLogging(
			{
				specificationVersion: "v1",
				provider: "example",
				modelId: "example-model",
				supportedQuestionTypes: ["boolean"],
				doDecide: async () => ({ usage }),
			} as any,
			{ ...context, callPurpose: undefined },
		);
		await runWithAiCallPurpose(P.completionJudge, () =>
			decision.doDecide({} as any),
		);
		expect(rows.mock.calls.map(([row]) => row.callPurpose)).toEqual([
			"tool-argument-repair",
			"trajectory-embedding",
			"completion-judge",
		]);
		for (const [row] of rows.mock.calls) {
			expect(row).toMatchObject({
				featureKey: "chat-agent",
				jobType: "scheduled-report",
			});
		}
	});
});
