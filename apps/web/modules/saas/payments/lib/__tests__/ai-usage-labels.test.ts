import { describe, expect, it } from "vitest";
import { formatUsageModel, formatUsageProvider } from "../ai-usage-labels";

describe("AI usage provider and model labels", () => {
	it.each([
		["CUSTOM", "attendee/teams-bot", "Attendee", "Teams meeting bot"],
		[
			"CLOUDFLARE_AI",
			"@cf/deepgram/flux",
			"Workers AI",
			"Deepgram Flux transcription",
		],
		[
			"CLOUDFLARE_AI",
			"@cf/deepgram/aura-2-en",
			"Workers AI",
			"Deepgram Aura speech",
		],
		["OPENAI_DIRECT", "gpt-realtime-2.1", "OpenAI", "gpt-realtime-2.1"],
		[
			"AZURE_AI_FOUNDRY",
			"gpt-realtime-2.1",
			"Azure AI Foundry",
			"gpt-realtime-2.1",
		],
		["OPENAI_CHATGPT_PLAN", "gpt-6-astra", "ChatGPT plan", "gpt-6-astra"],
	])(
		"names %s %s for people",
		(provider, providerModelId, providerLabel, modelLabel) => {
			const row = { provider, providerModelId, modelCanonicalName: null };
			expect(formatUsageProvider(row)).toBe(providerLabel);
			expect(formatUsageModel(row)).toBe(modelLabel);
		},
	);

	it("keeps the canonical model name and strips a gateway prefix otherwise", () => {
		expect(
			formatUsageModel({
				modelCanonicalName: "example-model",
				providerModelId: "example/example-model-2026",
			}),
		).toBe("example-model");
		expect(
			formatUsageModel({
				modelCanonicalName: null,
				providerModelId: "anthropic/claude-haiku-4.5",
			}),
		).toBe("claude-haiku-4.5");
	});

	it("reads an unknown provider as words rather than an enum", () => {
		expect(
			formatUsageProvider({
				provider: "SOME_NEW_PROVIDER",
				providerModelId: "example",
			}),
		).toBe("SOME NEW PROVIDER");
	});
});
