/**
 * The image step's prompt enhancement runs a text model, which may be a
 * ChatGPT plan (Fizzy #2770 D3). Enhancement is optional, so a plan refusal —
 * spent, ran out mid-reply, or not serving the model — skips it and the image
 * is generated from the original prompt; the node neither waits nor fails.
 * Any other enhancement failure still fails the node.
 */
import {
	PlanSourceRotatedError,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ logAiUsageAsync: vi.fn() }));
vi.mock("@repo/ai", () => ({
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
	applyFabricEnrichment: async () => ({
		fabricUsed: true,
		systemPrompt: "Enhance image prompts.",
	}),
}));

import {
	generateImage,
	getAIModelWithMetadata,
	getRAGProviderConfig,
} from "@repo/ai";
import { executeAiGenerateImageStep } from "../ai-generate-image";

const params = (enhancePrompt: boolean) => ({
	nodeConfig: {
		imagePrompt: "a paper boat",
		imageModel: "google/gemini-3.1-flash-image-preview",
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

	it("still fails the node on any other enhancement failure", async () => {
		vi.mocked(getAIModelWithMetadata).mockRejectedValue(new Error("boom"));
		await expect(
			executeAiGenerateImageStep(params(true)),
		).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining("boom"),
		});
		expect(generateImage).not.toHaveBeenCalled();
	});

	it("calls no text model without enhancement", async () => {
		await expect(
			executeAiGenerateImageStep(params(false)),
		).resolves.toMatchObject({ success: true });
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});
});
