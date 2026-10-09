/**
 * Which ChatGPT plan model serves which task (Fizzy #2939): the code defaults
 * cover every text task, a member's or organization's preference for the plan
 * wins over the defaults, and a model the plan refuses or no longer lists goes
 * once to the organization's fallback model, else fails naming the model
 * (Fizzy #2770 F10).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	userPreference: vi.fn(),
	modelForTask: vi.fn(),
	policy: vi.fn(),
	served: vi.fn(),
	refreshServed: vi.fn(),
	planSlugFor: vi.fn(async (_canonical: string) => null as string | null),
}));

vi.mock("@repo/database", () => ({
	DEFAULT_CHATGPT_PLAN_FALLBACK_MODEL: "gpt-6-astra",
	getUserModelPreference: mocks.userPreference,
	getModelForTask: mocks.modelForTask,
	getChatGptPlanOrgPolicy: mocks.policy,
	getCachedChatGptPlanOrgPolicy: mocks.policy,
	getChatGptPlanServedModels: mocks.served,
	getProviderModelIdForCanonical: mocks.planSlugFor,
	ensureChatGptPlanCatalogModels: vi.fn(),
	replaceChatGptPlanServedModels: vi.fn(),
}));
// The self-healing re-read of the plan's model list (Fizzy #2770): observed,
// never run, so no test reaches OpenAI.
vi.mock("../lib/chatgpt-plan/served-models", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../lib/chatgpt-plan/served-models")
	>()),
	refreshChatGptPlanServedModelsInBackground: mocks.refreshServed,
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
	getChatGptPlanSourceAccessToken: vi.fn(),
	refreshChatGptPlanSourceAfterUnauthorized: vi.fn(),
}));

import {
	CHATGPT_PLAN_HEAVY_MODEL,
	CHATGPT_PLAN_TASK_DEFAULTS,
	ChatGptPlanModelNotServedError,
	chatGptPlanApiPriceReference,
	resolveChatGptPlanModel,
} from "../lib/chatgpt-plan/models";
import { createChatGptPlanModel } from "../lib/chatgpt-plan/provider";
import { __resetChatGptPlanServedModelProbes } from "../lib/chatgpt-plan/served-models";

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
	__resetChatGptPlanServedModelProbes();
	mocks.userPreference.mockResolvedValue(null);
	mocks.modelForTask.mockResolvedValue(null);
	mocks.policy.mockResolvedValue({ fallbackModel: "gpt-6-astra" });
	mocks.served.mockResolvedValue([]);
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

	// Fizzy #2770 (DSU 2026-10-07): Sol for Fabric's work, Luna for light
	// tasks, each at its own default reasoning level; Astra only as the
	// fallback for a model a plan refuses, and no Terra.
	it("give GPT-6.1 Sol to every task but SIMPLE, which gets GPT-6 Luna, with no reasoning override", () => {
		expect(CHATGPT_PLAN_TASK_DEFAULTS).toEqual({
			COMPLEX: { model: "gpt-6.1-sol" },
			REASONING: { model: "gpt-6.1-sol" },
			TOOL_CALLING: { model: "gpt-6.1-sol" },
			CHAT: { model: "gpt-6.1-sol" },
			EVAL: { model: "gpt-6.1-sol" },
			SIMPLE: { model: "gpt-6-luna" },
		});
		expect(Object.values(CHATGPT_PLAN_TASK_DEFAULTS)).not.toContainEqual(
			expect.objectContaining({ model: CHATGPT_PLAN_HEAVY_MODEL }),
		);
	});

	it("price every plan model as a catalog API model", () => {
		expect(chatGptPlanApiPriceReference("gpt-6-astra")).toBe("gpt-6-astra");
		expect(chatGptPlanApiPriceReference("gpt-5.6-luna")).toBe("gpt-6-luna");
		expect(chatGptPlanApiPriceReference("gpt-5.6-sol")).toBe("gpt-6-sol");
		// F9: no API Terra; priced as Sol, not as Astra.
		expect(chatGptPlanApiPriceReference("gpt-5.6-terra")).toBe("gpt-6-sol");
		// A model the plan lists before the catalog knows it: same family.
		expect(chatGptPlanApiPriceReference("gpt-6.1-luna")).toBe("gpt-6-luna");
		expect(chatGptPlanApiPriceReference("an-unknown-plan-model")).toBe(
			"gpt-6-sol",
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
		await expect(resolveChatGptPlanModel(params)).resolves.toEqual({
			...CHATGPT_PLAN_TASK_DEFAULTS.SIMPLE,
			fallbackModel: "gpt-6-astra",
		});
		expect(mocks.modelForTask).toHaveBeenCalledWith(
			"user-1",
			"OPENAI_CHATGPT_PLAN",
			"SIMPLE",
			"org-1",
		);
	});

	// Fizzy #2770 (DSU 2026-10-07): the organization decides which plan model
	// runs which work; a member's own preference no longer overrides it.
	it("ignores a member's own preference: the organization's choice decides", async () => {
		mocks.userPreference.mockResolvedValue({
			model: { providerMappings: [{ providerModelId: "gpt-5.6-terra" }] },
		});
		mocks.modelForTask.mockResolvedValue({
			providerModelId: "gpt-5.6-sol",
			source: "org_override",
		});
		const choice = await resolveChatGptPlanModel(params);
		expect(choice.model).toBe("gpt-5.6-sol");
		expect(mocks.userPreference).not.toHaveBeenCalled();
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

describe("resolveChatGptPlanModel against the plan's model list", () => {
	const params = {
		userId: "user-1",
		organizationId: "org-1",
		taskType: "COMPLEX",
	};
	const served = (...slugs: string[]) =>
		mocks.served.mockResolvedValue(
			slugs.map((slug) => ({
				sourceKind: "USER",
				sourceId: "user-1",
				slug,
				checkedAt: new Date(),
			})),
		);

	it("keeps the chosen model while the plan lists it, or before it was ever checked", async () => {
		expect((await resolveChatGptPlanModel(params)).model).toBe(
			"gpt-6.1-sol",
		);
		served("gpt-6.1-sol", "gpt-6-astra");
		expect((await resolveChatGptPlanModel(params)).model).toBe(
			"gpt-6.1-sol",
		);
	});

	it("goes to the organization's fallback once the plan no longer lists the model", async () => {
		served("gpt-6-astra");
		await expect(resolveChatGptPlanModel(params)).resolves.toMatchObject({
			model: "gpt-6-astra",
			fallbackModel: "gpt-6-astra",
		});
	});

	it("fails naming the model with no fallback, or one the plan does not list either", async () => {
		served("gpt-5.6-luna");
		mocks.policy.mockResolvedValue({ fallbackModel: null });
		await expect(resolveChatGptPlanModel(params)).rejects.toThrow(
			new ChatGptPlanModelNotServedError("gpt-6.1-sol"),
		);
		mocks.policy.mockResolvedValue({ fallbackModel: "gpt-6-astra" });
		await expect(resolveChatGptPlanModel(params)).rejects.toBeInstanceOf(
			ChatGptPlanModelNotServedError,
		);
	});

	it("re-reads the plan's model list when it refuses the choice, so a stale list heals", async () => {
		mocks.refreshServed.mockClear();
		served("gpt-6-astra");
		await resolveChatGptPlanModel(params);
		expect(mocks.refreshServed).not.toHaveBeenCalled();

		served("gpt-5.6-luna");
		mocks.policy.mockResolvedValue({ fallbackModel: null });
		await expect(resolveChatGptPlanModel(params)).rejects.toBeInstanceOf(
			ChatGptPlanModelNotServedError,
		);
		expect(mocks.refreshServed).toHaveBeenCalledTimes(1);
		expect(mocks.refreshServed).toHaveBeenCalledWith({
			kind: "user",
			userId: "user-1",
		});
	});
});

// Fizzy #2770 F13: a person picks the model for one chat. It runs only when
// the plan serving the call serves it; anything else is the organization's
// choice, never an error.
describe("a chat's own model choice on the plan", () => {
	const params = {
		userId: "user-1",
		organizationId: "org-1",
		taskType: "TOOL_CALLING",
	};
	const served = (...slugs: string[]) =>
		mocks.served.mockResolvedValue(
			slugs.map((slug) => ({
				sourceKind: "USER",
				sourceId: "user-1",
				slug,
				checkedAt: new Date(),
			})),
		);

	it("runs the chosen model when the serving plan serves it", async () => {
		served("gpt-6.1-sol", "gpt-6-astra");
		await expect(
			resolveChatGptPlanModel({ ...params, override: "gpt-6-astra" }),
		).resolves.toMatchObject({ model: "gpt-6-astra" });
	});

	it("maps a catalog name to the plan's slug", async () => {
		served("gpt-6.1-sol", "gpt-7-nova");
		mocks.planSlugFor.mockResolvedValueOnce("gpt-7-nova");
		await expect(
			resolveChatGptPlanModel({
				...params,
				override: "gpt-7-nova-chatgpt-plan",
			}),
		).resolves.toMatchObject({ model: "gpt-7-nova" });
		expect(mocks.planSlugFor).toHaveBeenCalledWith(
			"gpt-7-nova-chatgpt-plan",
			"OPENAI_CHATGPT_PLAN",
		);
	});

	it("ignores a choice the plan does not serve, an unknown one, or one never checked", async () => {
		served("gpt-6.1-sol");
		await expect(
			resolveChatGptPlanModel({ ...params, override: "gpt-6-astra" }),
		).resolves.toMatchObject({ model: "gpt-6.1-sol" });
		await expect(
			resolveChatGptPlanModel({ ...params, override: "claude-sonnet-5" }),
		).resolves.toMatchObject({ model: "gpt-6.1-sol" });
		__resetChatGptPlanServedModelProbes();
		mocks.served.mockResolvedValue([]);
		await expect(
			resolveChatGptPlanModel({ ...params, override: "gpt-6-astra" }),
		).resolves.toMatchObject({ model: "gpt-6.1-sol" });
	});

	it("keeps the task's reasoning effort on the chat's model", async () => {
		served("gpt-6.1-sol", "gpt-6-astra");
		const original = CHATGPT_PLAN_TASK_DEFAULTS.TOOL_CALLING;
		CHATGPT_PLAN_TASK_DEFAULTS.TOOL_CALLING = {
			model: "gpt-6.1-sol",
			reasoningEffort: "high",
		};
		try {
			await expect(
				resolveChatGptPlanModel({ ...params, override: "gpt-6-astra" }),
			).resolves.toMatchObject({
				model: "gpt-6-astra",
				reasoningEffort: "high",
			});
		} finally {
			CHATGPT_PLAN_TASK_DEFAULTS.TOOL_CALLING = original;
		}
	});

	it("never fails because of a stale choice", async () => {
		served("gpt-6.1-sol");
		mocks.planSlugFor.mockRejectedValueOnce(new Error("database down"));
		await expect(
			resolveChatGptPlanModel({ ...params, override: "gpt-6-astra" }),
		).resolves.toMatchObject({ model: "gpt-6.1-sol" });
	});
});

describe("unsupported-model fallback (F10)", () => {
	it("retries once on the organization's fallback model", async () => {
		const baseFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(unsupported())
			.mockResolvedValueOnce(sseText("ok", "gpt-5.6-terra"));
		const onModelFallback = vi.fn();
		const result = await generateText({
			model: createChatGptPlanModel({
				userId: "user-1",
				modelId: "gpt-5.6-luna",
				fallbackModelId: "gpt-5.6-terra",
				onModelFallback,
				fetchImpl: baseFetch,
			}),
			prompt: "x",
			maxRetries: 0,
		});
		expect(result.text).toBe("ok");
		expect(baseFetch).toHaveBeenCalledTimes(2);
		const second = JSON.parse(String(baseFetch.mock.calls[1]?.[1]?.body));
		expect(second.model).toBe("gpt-5.6-terra");
		expect(onModelFallback).toHaveBeenCalledWith("gpt-5.6-terra");

		// Nothing is remembered per process any more: the next call asks again.
		const next = await resolveChatGptPlanModel({
			userId: "user-1",
			taskType: "SIMPLE",
		});
		expect(next.model).toBe("gpt-6-luna");
	});

	it("re-reads the plan's model list once when OpenAI refuses the model", async () => {
		mocks.refreshServed.mockClear();
		const baseFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(unsupported())
			.mockResolvedValueOnce(sseText("ok", "gpt-5.6-terra"));
		await generateText({
			model: createChatGptPlanModel({
				userId: "user-1",
				modelId: "gpt-5.6-luna",
				fallbackModelId: "gpt-5.6-terra",
				fetchImpl: baseFetch,
			}),
			prompt: "x",
			maxRetries: 0,
		});
		expect(mocks.refreshServed).toHaveBeenCalledTimes(1);
		expect(mocks.refreshServed).toHaveBeenCalledWith({
			kind: "user",
			userId: "user-1",
		});
	});

	it("fails naming the model, without a retry, when there is no fallback", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () => unsupported());
		const error = await generateText({
			model: createChatGptPlanModel({
				userId: "user-1",
				modelId: "gpt-5.6-luna",
				fallbackModelId: null,
				fetchImpl: baseFetch,
			}),
			prompt: "x",
			maxRetries: 0,
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ChatGptPlanModelNotServedError);
		expect((error as Error).message).toBe(
			"The ChatGPT plan does not serve gpt-5.6-luna. Choose another model in Organization settings → AI Models.",
		);
		expect(baseFetch).toHaveBeenCalledTimes(1);
	});

	it("does not loop when the fallback is the refused model itself", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () => unsupported());
		await expect(
			generateText({
				model: createChatGptPlanModel({
					userId: "user-1",
					modelId: CHATGPT_PLAN_HEAVY_MODEL,
					fallbackModelId: CHATGPT_PLAN_HEAVY_MODEL,
					fetchImpl: baseFetch,
				}),
				prompt: "x",
				maxRetries: 0,
			}),
		).rejects.toBeInstanceOf(ChatGptPlanModelNotServedError);
		expect(baseFetch).toHaveBeenCalledTimes(1);
	});

	it("fails naming the chosen model when the fallback is refused too", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () => unsupported());
		const error = await generateText({
			model: createChatGptPlanModel({
				userId: "user-1",
				modelId: "gpt-5.6-luna",
				fallbackModelId: CHATGPT_PLAN_HEAVY_MODEL,
				fetchImpl: baseFetch,
			}),
			prompt: "x",
			maxRetries: 0,
		}).catch((caught: unknown) => caught);
		expect(error).toEqual(
			new ChatGptPlanModelNotServedError("gpt-5.6-luna"),
		);
		expect(baseFetch).toHaveBeenCalledTimes(2);
	});

	// Temporal records a failure's type as its constructor's name; the
	// workflows' non-retryable list names this literal.
	it("is recorded by Temporal under the name the non-retryable list carries", () => {
		const error = new ChatGptPlanModelNotServedError("gpt-5.6-luna");
		expect(error.constructor.name).toBe("ChatGptPlanModelNotServedError");
		expect(error.name).toBe("ChatGptPlanModelNotServedError");
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
