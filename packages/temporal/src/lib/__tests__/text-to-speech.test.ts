import { runWithAiCallPurpose } from "@repo/ai/lib/call-purpose-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getAiProviderApiKeyByProvider: vi.fn(),
	logAiUsageAsync: vi.fn(),
}));

// Explicit mock (no importOriginal): the real @repo/database would keep
// pg.Pool handles alive past vitest exit.
vi.mock("@repo/database", () => ({
	getAiProviderApiKeyByProvider: h.getAiProviderApiKeyByProvider,
	logAiUsageAsync: h.logAiUsageAsync,
}));

// The real key resolver, so the platform-key rule is exercised end to end.
vi.mock("@repo/ai", async () => {
	const keys = await vi.importActual<
		typeof import("@repo/ai/lib/openai-provider-key")
	>("@repo/ai/lib/openai-provider-key");
	return {
		AUDIO_PROVIDER_REQUIRED: keys.AUDIO_PROVIDER_REQUIRED,
		resolveOpenAiApiKey: keys.resolveOpenAiApiKey,
	};
});

import { synthesizeToolSpeech } from "../text-to-speech";

const EMPTY_PROVIDER_CONFIG = {
	apiKey: null,
	configId: null,
	provider: null,
	baseUrl: null,
	enabledProviders: [],
	source: null,
	deploymentName: null,
	clientId: null,
	encryptedClientSecret: null,
};

const REQUEST = {
	userId: "user-example-1",
	organizationId: "org-example-1",
	text: "The launch moved to the 12th.",
	voice: "alloy",
	speed: 1,
};

describe("synthesizeToolSpeech", () => {
	const originalEnvKey = process.env.OPENAI_API_KEY;
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		// Fabric's own key is present; it must never be used.
		process.env.OPENAI_API_KEY = "sk-platform-example";
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalEnvKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = originalEnvKey;
		}
	});

	it.each([200, 503])(
		"retains the Workspace origin for speech HTTP %s",
		async (status) => {
			h.getAiProviderApiKeyByProvider.mockResolvedValue({
				...EMPTY_PROVIDER_CONFIG,
				provider: "OPENAI_DIRECT",
				apiKey: "key-example",
				source: "organization",
			});
			fetchMock.mockResolvedValue(
				new Response(new Uint8Array([1]), { status }),
			);
			const usageOrigin = {
				projectId: "project-example",
				frameId: "frame-example",
				workflowExecutionId: "execution-example",
			};
			await runWithAiCallPurpose("compaction", () =>
				synthesizeToolSpeech({ ...REQUEST, usageOrigin }),
			);
			expect(h.logAiUsageAsync).toHaveBeenCalledOnce();
			expect(h.logAiUsageAsync.mock.calls[0][0]).toMatchObject({
				...usageOrigin,
				callPurpose: "speech-generation",
				featureKey: "text-to-speech",
				taskType: "AUDIO",
				success: status === 200,
			});
		},
	);

	it.each(["conversation-example", undefined])(
		"records the supplied speech conversation (%s)",
		async (usageConversationId) => {
			h.getAiProviderApiKeyByProvider.mockResolvedValue({
				...EMPTY_PROVIDER_CONFIG,
				provider: "OPENAI_DIRECT",
				apiKey: "key-example",
				source: "organization",
			});
			fetchMock.mockResolvedValue(new Response(new Uint8Array([1])));
			await synthesizeToolSpeech({ ...REQUEST, usageConversationId });
			expect(h.logAiUsageAsync.mock.calls[0][0].conversationId).toBe(
				usageConversationId,
			);
		},
	);

	it("refuses without calling OpenAI when the organization has no OpenAI key", async () => {
		h.getAiProviderApiKeyByProvider.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
		});

		const result = await synthesizeToolSpeech(REQUEST);

		expect(result).toEqual({
			ok: false,
			error: "Voice needs an AI provider for your organization. Add an OpenAI API key in Settings → AI Providers. ChatGPT plans serve text only.",
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(h.logAiUsageAsync).not.toHaveBeenCalled();
	});

	it("speaks on the organization's own key and writes a usage row", async () => {
		h.getAiProviderApiKeyByProvider.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
			provider: "OPENAI_DIRECT",
			apiKey: "sk-org-example",
			source: "organization",
		});
		fetchMock.mockResolvedValue(
			new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
		);

		const result = await synthesizeToolSpeech(REQUEST);

		expect(result.ok).toBe(true);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.openai.com/v1/audio/speech");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer sk-org-example",
		);
		expect(h.logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(h.logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			userId: "user-example-1",
			organizationId: "org-example-1",
			provider: "OPENAI_DIRECT",
			providerModelId: "tts-1",
			taskType: "AUDIO",
			featureKey: "text-to-speech",
			success: true,
			costUsd: REQUEST.text.length * (15 / 1_000_000),
		});
	});

	it("records a failed speech request in usage", async () => {
		h.getAiProviderApiKeyByProvider.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
			provider: "OPENAI_DIRECT",
			apiKey: "sk-org-example",
			source: "organization",
		});
		fetchMock.mockResolvedValue(new Response("slow down", { status: 429 }));

		const result = await synthesizeToolSpeech(REQUEST);

		expect(result).toEqual({
			ok: false,
			error: "TTS API error 429: slow down",
		});
		expect(h.logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			featureKey: "text-to-speech",
			success: false,
			costUsd: 0,
			errorMessage: "TTS API error 429: slow down",
		});
	});
});
