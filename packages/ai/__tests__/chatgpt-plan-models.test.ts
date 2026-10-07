/**
 * Which ChatGPT plan model serves which task (Fizzy #2939): the code defaults
 * cover every text task, a member's or organization's preference for the plan
 * wins over the defaults, and a model the member's plan refuses is retried once
 * on the heavy default and then skipped.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	userPreference: vi.fn(),
	modelForTask: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getUserModelPreference: mocks.userPreference,
	getModelForTask: mocks.modelForTask,
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/chatgpt-plan/plan-credentials", () => ({
	getChatGptPlanAccessToken: async () => ({
		accessToken: "access-1",
		expiresAt: new Date(Date.now() + 3_600_000),
	}),
	refreshChatGptPlanAfterUnauthorized: vi.fn(),
}));

import {
	__resetChatGptPlanModelMemory,
	CHATGPT_PLAN_HEAVY_MODEL,
	CHATGPT_PLAN_TASK_DEFAULTS,
	chatGptPlanApiPriceReference,
	resolveChatGptPlanModel,
} from "../lib/chatgpt-plan/models";
import { createChatGptPlanModel } from "../lib/chatgpt-plan/provider";

const NON_TEXT = new Set(["EMBEDDING", "IMAGE", "AUDIO", "DECISION"]);

function schemaTaskTypes(): string[] {
	const schema = readFileSync(
		join(__dirname, "../../database/prisma/schema.prisma"),
		"utf8",
	);
	const block = schema.match(/enum AiTaskType \{([^}]*)\}/)?.[1] ?? "";
	return block
		.split("\n")
		.map((line) => line.trim().split(/\s/)[0])
		.filter(
			(word): word is string =>
				Boolean(word) && /^[A-Z_]+$/.test(word ?? ""),
		);
}

beforeEach(() => {
	vi.clearAllMocks();
	__resetChatGptPlanModelMemory();
	mocks.userPreference.mockResolvedValue(null);
	mocks.modelForTask.mockResolvedValue(null);
});

describe("plan model defaults", () => {
	it("cover every text task type, and only those", () => {
		const textTasks = schemaTaskTypes().filter(
			(task) => !NON_TEXT.has(task),
		);
		expect(textTasks.length).toBeGreaterThan(4);
		expect(Object.keys(CHATGPT_PLAN_TASK_DEFAULTS).sort()).toEqual(
			textTasks.sort(),
		);
	});

	it("give heavy work the heavy model and light work a lighter one", () => {
		expect(CHATGPT_PLAN_TASK_DEFAULTS.COMPLEX.model).toBe(
			CHATGPT_PLAN_HEAVY_MODEL,
		);
		expect(CHATGPT_PLAN_TASK_DEFAULTS.TOOL_CALLING.model).toBe(
			CHATGPT_PLAN_HEAVY_MODEL,
		);
		expect(CHATGPT_PLAN_TASK_DEFAULTS.SIMPLE.model).not.toBe(
			CHATGPT_PLAN_HEAVY_MODEL,
		);
	});

	it("price every plan model as a catalog API model", () => {
		expect(chatGptPlanApiPriceReference("gpt-6-astra")).toBe("gpt-6-astra");
		expect(chatGptPlanApiPriceReference("gpt-5.6-luna")).toBe("gpt-6-luna");
		expect(chatGptPlanApiPriceReference("an-unknown-plan-model")).toBe(
			"gpt-6-astra",
		);
	});
});

describe("resolveChatGptPlanModel", () => {
	const params = {
		userId: "user-1",
		organizationId: "org-1",
		taskType: "SIMPLE",
	};

	it("uses the code default when no preference or seeded default names one", async () => {
		await expect(resolveChatGptPlanModel(params)).resolves.toEqual(
			CHATGPT_PLAN_TASK_DEFAULTS.SIMPLE,
		);
		expect(mocks.modelForTask).toHaveBeenCalledWith(
			"user-1",
			"OPENAI_CHATGPT_PLAN",
			"SIMPLE",
			"org-1",
		);
	});

	it("lets the member's own preference for the plan win, in any organization", async () => {
		mocks.userPreference.mockResolvedValue({
			model: { providerMappings: [{ providerModelId: "gpt-5.6-terra" }] },
		});
		const choice = await resolveChatGptPlanModel(params);
		expect(choice.model).toBe("gpt-5.6-terra");
		expect(mocks.modelForTask).not.toHaveBeenCalled();
	});

	it("uses the organization's preference or the seeded default next", async () => {
		mocks.modelForTask.mockResolvedValue({
			providerModelId: "gpt-5.6-sol",
			source: "org_override",
		});
		expect((await resolveChatGptPlanModel(params)).model).toBe(
			"gpt-5.6-sol",
		);
	});

	it("treats a switched-off task as the default, not as no model", async () => {
		mocks.userPreference.mockResolvedValue({ model: null });
		mocks.modelForTask.mockResolvedValue(null);
		expect((await resolveChatGptPlanModel(params)).model).toBe(
			CHATGPT_PLAN_TASK_DEFAULTS.SIMPLE.model,
		);
	});

	it("falls back to the default when the lookup fails", async () => {
		mocks.userPreference.mockRejectedValue(new Error("db down"));
		expect((await resolveChatGptPlanModel(params)).model).toBe(
			CHATGPT_PLAN_TASK_DEFAULTS.SIMPLE.model,
		);
	});
});

function sseText(text: string, model: string): Response {
	const output = [
		{
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text, annotations: [] }],
		},
	];
	const response = {
		id: "resp_1",
		object: "response",
		created_at: 1_790_000_000,
		status: "completed",
		model,
		output,
		usage: {
			input_tokens: 3,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 2,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 5,
		},
	};
	return new Response(
		[
			{ type: "response.output_item.done", item: output[0] },
			{ type: "response.completed", response },
		]
			.map(
				(event) =>
					`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

const unsupported = () =>
	new Response(
		JSON.stringify({
			error: {
				message:
					"The model 'gpt-5.6-luna' is not supported on this plan.",
				code: "model_not_found",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);

describe("unsupported-model fallback", () => {
	it("retries once on the heavy default and remembers the refusal", async () => {
		const baseFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(unsupported())
			.mockResolvedValueOnce(sseText("ok", CHATGPT_PLAN_HEAVY_MODEL));
		const onModelFallback = vi.fn();
		const result = await generateText({
			model: createChatGptPlanModel({
				userId: "user-1",
				modelId: "gpt-5.6-luna",
				onModelFallback,
				fetchImpl: baseFetch,
			}),
			prompt: "x",
			maxRetries: 0,
		});
		expect(result.text).toBe("ok");
		expect(baseFetch).toHaveBeenCalledTimes(2);
		const second = JSON.parse(String(baseFetch.mock.calls[1]?.[1]?.body));
		expect(second.model).toBe(CHATGPT_PLAN_HEAVY_MODEL);
		expect(onModelFallback).toHaveBeenCalledWith(CHATGPT_PLAN_HEAVY_MODEL);

		const next = await resolveChatGptPlanModel({
			userId: "user-1",
			taskType: "SIMPLE",
		});
		expect(next.model).toBe(CHATGPT_PLAN_HEAVY_MODEL);
	});

	it("does not loop when the heavy default itself is refused", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () => unsupported());
		await expect(
			generateText({
				model: createChatGptPlanModel({
					userId: "user-1",
					modelId: CHATGPT_PLAN_HEAVY_MODEL,
					fetchImpl: baseFetch,
				}),
				prompt: "x",
				maxRetries: 0,
			}),
		).rejects.toThrow();
		expect(baseFetch).toHaveBeenCalledTimes(1);
	});

	it("sends the task's reasoning effort", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () =>
			sseText("ok", CHATGPT_PLAN_HEAVY_MODEL),
		);
		await generateText({
			model: createChatGptPlanModel({
				userId: "user-1",
				modelId: CHATGPT_PLAN_HEAVY_MODEL,
				reasoningEffort: "high",
				fetchImpl: baseFetch,
			}),
			prompt: "x",
		});
		const body = JSON.parse(String(baseFetch.mock.calls[0]?.[1]?.body));
		expect(body.reasoning?.effort).toBe("high");
	});
});
