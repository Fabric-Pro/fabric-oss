/**
 * The image step's prompt enhancement runs a text model, which may be a
 * ChatGPT plan (Fizzy #2770 D3). Enhancement is optional, so a plan refusal —
 * spent, ran out mid-reply, or not serving the model — skips it and the image
 * is generated from the original prompt; the node neither waits nor fails.
 * Other enhancement failures also fall back to the original prompt.
 */
import {
	PlanSourceRotatedError,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { RetryError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ logAiUsageAsync: vi.fn() }));
vi.mock("@repo/ai", () => ({
	isVercelGatewayKey: (apiKey: string) => apiKey.startsWith("vck_"),
	createGateway: () => {
		const gateway = vi.fn((model: string) => ({ modelId: model }));
		(
			gateway as unknown as { imageModel: (m: string) => unknown }
		).imageModel = (m: string) => ({ modelId: m });
		return gateway;
	},
	generateImage: vi.fn(),
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	getRAGProviderConfig: vi.fn(),
}));
vi.mock("../fabric-enrichment", () => ({
	extractFabricConfig: () => ({}),
	applyFabricEnrichment: vi.fn(async () => ({
		fabricUsed: true,
		systemPrompt: "Enhance image prompts.",
	})),
}));

import {
	generateImage,
	generateText,
	getAIModelWithMetadata,
	getRAGProviderConfig,
} from "@repo/ai";
import { executeAiGenerateImageStep } from "../ai-generate-image";
import { applyFabricEnrichment } from "../fabric-enrichment";

const params = (enhancePrompt: boolean) => ({
	nodeConfig: {
		imagePrompt: "a paper boat",
		imageModel: "google/gemini-3.1-flash-image",
		enhancePrompt,
	},
	inputs: {},
	userId: "user-1",
	organizationId: "org-1",
	jobType: "workflow-builder" as const,
});

class ChatGptPlanModelNotServedError extends Error {
	constructor() {
		super("The ChatGPT plan does not serve gpt-5.6-luna.");
		this.name = "ChatGptPlanModelNotServedError";
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getRAGProviderConfig).mockResolvedValue({
		apiKey: "gateway-key",
		provider: "VERCEL_GATEWAY",
	} as never);
	vi.mocked(generateImage).mockResolvedValue({
		image: { base64: "aGk=", uint8Array: new Uint8Array([1]) },
	} as never);
});

describe("executeAiGenerateImageStep — a ChatGPT plan refusal during enhancement", () => {
	it.each([
		[
			"spent",
			() => new SubscriptionPlanExhaustedError("No usage left", null),
		],
		["ran out mid-reply", () => new PlanSourceRotatedError()],
		[
			"does not serve the model",
			() => new ChatGptPlanModelNotServedError(),
		],
	])(
		"skips enhancement when the plan %s, and generates from the original prompt",
		async (_label, refusal) => {
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			vi.mocked(getAIModelWithMetadata).mockRejectedValue(refusal());
			await expect(
				executeAiGenerateImageStep(params(true)),
			).resolves.toMatchObject({ success: true });
			expect(generateImage).toHaveBeenCalledWith(
				expect.objectContaining({ prompt: "a paper boat" }),
			);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("Prompt enhancement skipped"),
				expect.anything(),
			);
			warn.mockRestore();
		},
	);

	it.each(["resolution", "text call", "enrichment"])(
		"uses the original prompt after a %s enhancement failure",
		async (stage) => {
			const failure = Object.assign(
				new Error("sk-example-not-a-real-key"),
				{ statusCode: 401 },
			);
			vi.mocked(getAIModelWithMetadata).mockResolvedValue({
				model: {},
			} as never);
			if (stage === "resolution") {
				vi.mocked(getAIModelWithMetadata).mockRejectedValue(failure);
			} else if (stage === "text call") {
				vi.mocked(generateText).mockRejectedValue(failure);
			} else {
				vi.mocked(applyFabricEnrichment).mockRejectedValueOnce(failure);
			}
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			try {
				const result = await executeAiGenerateImageStep(params(true));
				expect(result).toMatchObject({
					success: true,
					output: { prompt: "a paper boat", enhancedPrompt: null },
				});
				expect(JSON.stringify(result)).not.toContain(
					"Vercel AI Gateway",
				);
				expect(JSON.stringify(result)).not.toContain(
					"sk-example-not-a-real-key",
				);
				expect(generateImage).toHaveBeenCalledWith(
					expect.objectContaining({ prompt: "a paper boat" }),
				);
				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("Prompt enhancement skipped"),
					failure,
				);
			} finally {
				warn.mockRestore();
			}
		},
	);

	it.each([
		["bare", (error: Error) => error],
		[
			"wrapped in a retry",
			(error: Error) =>
				new RetryError({
					message: "Failed after 2 attempts",
					reason: "maxRetriesExceeded",
					errors: [new Error("first attempt"), error],
				}),
		],
	])(
		"stops the node on a hard usage limit during enhancement (%s), without generating",
		async (_label, wrap) => {
			const limit = new AiUsageLimitExceededError({
				message:
					"Your organization reached its monthly AI usage limit.",
				limitId: "limit-1",
				dimension: "COST" as never,
				window: "MONTH" as never,
				used: 10n,
				max: 10n,
				manageLimitsUrl: "https://example.com/settings/ai-usage",
			});
			vi.mocked(getAIModelWithMetadata).mockRejectedValue(wrap(limit));
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			try {
				await expect(
					executeAiGenerateImageStep(params(true)),
				).resolves.toEqual({
					success: false,
					error: "Your organization reached its monthly AI usage limit.",
				});
				expect(generateImage).not.toHaveBeenCalled();
			} finally {
				warn.mockRestore();
			}
		},
	);

	it("calls no text model without enhancement", async () => {
		await expect(
			executeAiGenerateImageStep(params(false)),
		).resolves.toMatchObject({ success: true });
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("attributes the enhancement text model to the same Workspace and run", async () => {
		vi.mocked(getAIModelWithMetadata).mockResolvedValue({
			model: {},
		} as never);
		vi.mocked(generateText).mockResolvedValue({
			text: "A detailed paper boat",
		} as never);
		await executeAiGenerateImageStep({
			...params(true),
			executionId: "execution",
			frameId: "workspace",
		});
		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			expect.objectContaining({
				workflowExecutionId: "execution",
				frameId: "workspace",
			}),
		);
	});
});
