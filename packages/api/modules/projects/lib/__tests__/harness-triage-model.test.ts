import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolve: vi.fn(),
	mapping: vi.fn(),
	send: vi.fn(),
}));
vi.mock("@repo/ai/model-selector", () => ({
	getAIModelWithMetadata: m.resolve,
}));
vi.mock("@repo/ai", async () => ({
	generateText: (await import("ai")).generateText,
}));
vi.mock("@repo/database", () => ({
	db: { aiModelProviderMapping: { findFirst: m.mapping } },
}));

import {
	generateTriageModelOnce,
	resolveTriageModel,
} from "../harness-triage-model";

const scope = {
	organizationId: "example-org",
	projectId: "example-project",
	userId: "example-user",
};
const pin = {
	provider: "OPENAI_DIRECT" as const,
	modelString: "example-model",
	canonicalName: "example-model",
	configId: "example-config",
	configSource: "organization" as const,
	routeHash: "a".repeat(64),
	maxOutputTokens: 128,
	contextWindow: 32768,
	inputRate: 1,
	outputRate: 2,
};
const usage = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 4, text: 4, reasoning: 0 },
};
const output = {
	content: [
		{
			type: "tool-call" as const,
			toolCallId: "example-call",
			toolName: "read_selected_evidence",
			input: '{"observationId":"example-observation"}',
		},
	],
	finishReason: { unified: "tool-calls" as const, raw: undefined },
	usage,
	warnings: [],
};
const request = {
	reservationId: "example-run:model:1",
	callId: "example-run:model:1",
	requestDigest: "b".repeat(64),
	authority: {
		runId: "example-run",
		organizationId: scope.organizationId,
		actorId: scope.userId,
		projectId: scope.projectId,
		inputHash: "c".repeat(64),
		evidence: [],
		model: { id: pin.modelString, maxOutputTokens: 128 },
	},
	request: {
		messages: [
			{
				role: "system" as const,
				content: "Example trusted triage instructions",
			},
			{
				role: "user" as const,
				content: "Example selected-evidence task",
			},
		],
		tools: [
			{
				name: "read_selected_evidence",
				inputSchema: {
					type: "object",
					properties: { observationId: { type: "string" } },
					required: ["observationId"],
				},
			},
		],
	},
	maxOutputTokens: 128,
	signal: new AbortController().signal,
};
beforeEach(() => {
	vi.resetAllMocks();
	m.send.mockResolvedValue(output);
	const model = new MockLanguageModelV4({
		provider: "openai.chat",
		modelId: "example-model",
		doGenerate: m.send,
	});
	m.resolve.mockResolvedValue({
		model,
		metadata: {
			...pin,
			maxOutputTokens: 128,
			answerSnapshot: { routeHash: pin.routeHash },
			planSource: undefined,
		},
	});
	m.mapping.mockResolvedValue({
		inputCostPer1M: 1,
		outputCostPer1M: 2,
		model: { inputCostPer1M: 1, outputCostPer1M: 2 },
	});
});
describe("configured triage physical model bridge", () => {
	it("pins a saved direct configuration and explicitly excludes ambient plan execution", async () => {
		const out = await resolveTriageModel(scope);
		expect(out.pin).toEqual(pin);
		expect(m.resolve).toHaveBeenCalledWith(
			expect.objectContaining({
				taskType: "TOOL_CALLING",
				requiresToolCalling: true,
			}),
			expect.objectContaining({
				...scope,
				planEligible: false,
				excludeChatGptPlan: true,
			}),
		);
	});
	it("makes one capped model request and returns tool calls without executing them", async () => {
		const out = await generateTriageModelOnce(scope, pin, request);
		expect(m.send).toHaveBeenCalledOnce();
		expect(m.send).toHaveBeenCalledWith(
			expect.objectContaining({ maxOutputTokens: 128 }),
		);
		expect(out.toolCalls).toEqual([
			{
				id: "example-call",
				name: "read_selected_evidence",
				input: { observationId: "example-observation" },
			},
		]);
		expect(out.usage).toMatchObject({
			inputTokens: 10,
			outputTokens: 4,
			costUsd: 18 / 1e6,
		});
	});
	it("does not retry a failed physical send", async () => {
		m.send.mockRejectedValue(
			Object.assign(Error("Example request failed"), {
				isRetryable: true,
			}),
		);
		await expect(
			generateTriageModelOnce(scope, pin, request),
		).rejects.toThrow();
		expect(m.send).toHaveBeenCalledOnce();
	});
	it("refuses an implicit gateway behind direct-provider metadata before any model send", async () => {
		const resolved = await m.resolve();
		resolved.model = new MockLanguageModelV4({
			provider: "gateway",
			doGenerate: m.send,
		});
		await expect(
			generateTriageModelOnce(scope, pin, request),
		).rejects.toThrow("TRIAGE_MODEL_UNAVAILABLE");
		expect(m.send).not.toHaveBeenCalled();
	});
	it("refuses changed approved pricing instead of silently raising spend", async () => {
		m.mapping.mockResolvedValue({
			inputCostPer1M: 2,
			outputCostPer1M: 2,
			model: {},
		});
		await expect(
			generateTriageModelOnce(scope, pin, request),
		).rejects.toThrow("TRIAGE_MODEL_CHANGED");
		expect(m.send).not.toHaveBeenCalled();
	});
	it("refuses an unpriced model before a physical send", async () => {
		m.mapping.mockResolvedValue(null);
		await expect(
			generateTriageModelOnce(scope, pin, request),
		).rejects.toThrow("TRIAGE_PRICING_UNAVAILABLE");
		expect(m.send).not.toHaveBeenCalled();
	});
	it("withholds incomplete output after one paid request", async () => {
		m.send.mockResolvedValue({
			...output,
			finishReason: { unified: "length", raw: "length" },
		});
		await expect(
			generateTriageModelOnce(scope, pin, request),
		).rejects.toThrow("TRIAGE_MODEL_INCOMPLETE");
		expect(m.send).toHaveBeenCalledOnce();
	});
	it("pre-cancellation prevents even configured-model resolution", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			generateTriageModelOnce(scope, pin, {
				...request,
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(m.resolve).not.toHaveBeenCalled();
		expect(m.send).not.toHaveBeenCalled();
	});
});

it("does not enable automatic answer-route recovery for an approved call", async () => {
	await resolveTriageModel(scope, pin);
	expect(m.resolve.mock.calls[0][0]).not.toHaveProperty("answerSnapshot");
});
