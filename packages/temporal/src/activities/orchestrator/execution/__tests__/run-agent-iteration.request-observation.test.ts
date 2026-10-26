import { createRequestObservationMiddleware } from "@repo/ai/lib/request-observation";
import { ApplicationFailure } from "@temporalio/common";
import { wrapLanguageModel } from "ai";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	streamText: vi.fn(),
	model: undefined as unknown,
	skills: false,
}));
vi.mock("@repo/ai", () => ({
	streamText: mocks.streamText,
	tool: (value: unknown) => value,
	jsonSchema: (value: unknown) => value,
	isStepCount: (n: number) => n,
}));
vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: async () =>
		mocks.skills ? [{ slug: "example-skill" }] : [],
	createSkillTools: () => ({
		list_skills: {},
		load_skill: {},
		read_skill_file: {},
	}),
	buildSkillsSystemBlock: () => "Example skills",
}));
vi.mock("@temporalio/activity", async (original) => ({
	...(await original<Record<string, unknown>>()),
	heartbeat: vi.fn(),
}));
vi.mock("../../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));
vi.mock("../../utils", () => ({
	getAiModelWithSelection: async () => ({
		model: mocks.model,
		provider: "OPENAI_DIRECT",
		modelString: "example-model",
		canonicalName: "example-model",
	}),
}));

import { runAgentIteration } from "../run-agent-iteration";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.skills = false;
});
it("returns the physical attempts with per-request cache use instead of the retry total", async () => {
	let attempt = 0;
	mocks.model = wrapLanguageModel({
		model: {
			specificationVersion: "v4",
			provider: "example",
			modelId: "example-model",
			supportedUrls: {},
			doGenerate: async () => ({
				content: [],
				finishReason: { unified: "stop", raw: "stop" },
				warnings: [],
				usage: {
					inputTokens: {
						total: 100,
						cacheRead: 70,
						cacheWrite: 10,
						noCache: 20,
					},
					outputTokens: { total: 5, text: 5, reasoning: undefined },
				},
			}),
			doStream: async () => {
				throw new Error("unused");
			},
		},
		middleware: createRequestObservationMiddleware(),
	});
	mocks.streamText.mockImplementation((request) => {
		const generated = request.model.doGenerate({
			prompt: [
				{ role: "system", content: request.instructions },
				...request.messages,
			],
			maxOutputTokens: 100,
		});
		const thisAttempt = ++attempt;
		return {
			stream: (async function* () {
				await generated;
				if (thisAttempt === 1) {
					yield { type: "error", error: new Error("transient 502") };
				} else {
					yield { type: "text-delta", text: "Example answer." };
				}
			})(),
			usage: generated.then(() => ({
				inputTokens: 100,
				outputTokens: 5,
			})),
			finishReason: Promise.resolve("stop"),
		};
	});
	const result = await runAgentIteration({
		conversationHistory: [
			{
				role: "user",
				content: "PRIVATE_SENTINEL",
				timestamp: "2026-01-01",
			},
		],
		availableTools: {},
		systemPrompt: "Example",
		userId: "example-user",
		executionId: "example-execution",
		iteration: 3,
		enableSkillTools: false,
	});
	expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 10 });
	expect(result.requests).toHaveLength(2);
	expect(
		result.requests?.map((request) => ({
			attempt: request.streamAttempt,
			read: request.cacheReadTokens,
			write: request.cacheWriteTokens,
			uncached: request.uncachedInputTokens,
			output: request.outputTokens,
		})),
	).toEqual([
		{ attempt: 1, read: 70, write: 10, uncached: 20, output: 5 },
		{ attempt: 2, read: 70, write: 10, uncached: 20, output: 5 },
	]);
	expect(JSON.stringify(result.requests)).not.toContain("PRIVATE_SENTINEL");
});

it("keeps completed request observations when a retry is refused by the ledger", async () => {
	const refusal = ApplicationFailure.create({
		message: "No room",
		type: "TurnBudgetExhausted",
		nonRetryable: true,
		details: [{ kind: "EXPLORATION", room: 0 }],
	});
	const model = wrapLanguageModel({
		model: {
			specificationVersion: "v4",
			provider: "example",
			modelId: "example",
			supportedUrls: {},
			doGenerate: async () => ({
				content: [],
				finishReason: { unified: "stop", raw: "stop" },
				warnings: [],
				usage: {
					inputTokens: {
						total: 100,
						noCache: 100,
						cacheRead: 0,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: 1, reasoning: undefined },
				},
			}),
			doStream: async () => {
				throw new Error("unused");
			},
		},
		middleware: createRequestObservationMiddleware(),
	});
	mocks.model = model;
	mocks.streamText
		.mockImplementationOnce((request) => {
			const sent = request.model.doGenerate({
				prompt: [{ role: "user", content: "Example" }],
			});
			return {
				stream: (async function* () {
					await sent;
					yield { type: "error", error: new Error("transient") };
				})(),
				usage: sent.then(() => ({ inputTokens: 100, outputTokens: 1 })),
				finishReason: Promise.resolve("stop"),
			};
		})
		.mockImplementationOnce(() => {
			throw refusal;
		});
	await expect(
		runAgentIteration({
			conversationHistory: [
				{ role: "user", content: "Example", timestamp: "2026-01-01" },
			],
			systemPrompt: "Example",
			availableTools: {},
			userId: "example",
			executionId: "example",
			iteration: 1,
			enableSkillTools: false,
		}),
	).rejects.toBe(refusal);
	expect(refusal.details?.[0]).toEqual({ kind: "EXPLORATION", room: 0 });
	expect(refusal.details?.[1]).toMatchObject({
		advisorRequestDiagnosticsV1: {
			requests: [{ inputTokens: 100, outputTokens: 1 }],
		},
	});
});

it("records the skill bindings added by the activity registry beside physical request fingerprints", async () => {
	mocks.skills = true;
	mocks.model = wrapLanguageModel({
		model: {
			specificationVersion: "v4",
			provider: "example",
			modelId: "example",
			supportedUrls: {},
			doGenerate: async () => ({
				content: [],
				finishReason: { unified: "stop", raw: "stop" },
				warnings: [],
				usage: {
					inputTokens: {
						total: 1,
						noCache: 1,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: 1, reasoning: undefined },
				},
			}),
			doStream: async () => {
				throw new Error("unused");
			},
		},
		middleware: createRequestObservationMiddleware(),
	});
	mocks.streamText.mockImplementation((request) => {
		const generated = request.model.doGenerate({
			prompt: [{ role: "system", content: request.instructions }],
			tools: Object.keys(request.tools).map((name) => ({
				type: "function",
				name,
				inputSchema: { type: "object" },
			})),
		});
		return {
			stream: (async function* () {
				await generated;
				yield { type: "text-delta", text: "Example answer." };
			})(),
			usage: generated.then(() => ({ inputTokens: 1, outputTokens: 1 })),
			finishReason: Promise.resolve("stop"),
		};
	});
	const result = await runAgentIteration({
		conversationHistory: [
			{ role: "user", content: "Example", timestamp: "2026-01-01" },
		],
		systemPrompt: "Example",
		availableTools: {},
		userId: "example",
		executionId: "example",
		iteration: 1,
	});
	expect(result.requests?.[0]).toMatchObject({
		toolNames: ["list_skills", "load_skill", "read_skill_file"],
		skillToolNames: ["list_skills", "load_skill", "read_skill_file"],
	});
});
