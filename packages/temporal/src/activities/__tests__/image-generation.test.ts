import { runWithAiCallPurpose } from "@repo/ai/lib/call-purpose-context";
import { DatabricksOAuthError } from "@repo/ai/lib/databricks-oauth";
import { runWithDispatchGuard } from "@repo/utils/dispatch-guard";
import { CancelledFailure } from "@temporalio/common";
import { APICallError, RetryError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	AIProviderNotConfiguredError,
	getImageModel,
	getAiProviderApiKeyByProvider,
	logAiUsageAsync,
	recordChatMediaObject,
	resolveImageModelChoice,
	resolveOpenAiApiKey,
	resolveChatMediaAccess,
	resolveProviderApiKey,
	updateProviderLastUsed,
} = vi.hoisted(() => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
	getImageModel: vi.fn(),
	getAiProviderApiKeyByProvider: vi.fn(),
	logAiUsageAsync: vi.fn(),
	recordChatMediaObject: vi.fn(),
	resolveImageModelChoice: vi.fn(),
	resolveOpenAiApiKey: vi.fn(),
	resolveChatMediaAccess: vi.fn(),
	resolveProviderApiKey: vi.fn(),
	updateProviderLastUsed: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	fetchCredentialsByProvider: vi.fn(),
	getAiProviderApiKeyByProvider,
	logAiUsageAsync,
	resolveImageModelChoice,
	resolveModel: vi.fn(),
	recordChatMediaObject,
	resolveChatMediaAccess,
	updateProviderLastUsed,
}));
vi.mock("@google/genai", () => ({ GoogleGenAI: vi.fn() }));
vi.mock("@repo/storage", () => ({
	deleteFile: vi.fn(),
	downloadFile: vi.fn(),
	getSignedUrl: vi.fn().mockResolvedValue("https://signed.example/image.png"),
	uploadFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError,
	isVercelGatewayKey: (apiKey: string) => apiKey.startsWith("vck_"),
	createGateway: vi.fn(() => {
		const gateway = vi.fn((model: string) => ({ modelId: model }));
		(
			gateway as unknown as { imageModel: (m: string) => unknown }
		).imageModel = (m: string) => ({ modelId: m });
		return gateway;
	}),
	generateImage: vi.fn(),
	generateText: vi.fn(),
	getImageModel,
	getRAGProviderConfig: vi.fn(),
	resolveOpenAiApiKey,
	resolveProviderApiKey,
}));

import { ChatMediaPersistenceError } from "../chat-media";
import {
	generateImageActivity,
	supportsInputImageEdits,
} from "../image-generation";

beforeEach(() => {
	resolveChatMediaAccess.mockReset().mockResolvedValue("allow");
	getAiProviderApiKeyByProvider.mockReset().mockResolvedValue({
		provider: null,
		source: null,
		apiKey: null,
	});
	resolveImageModelChoice.mockReset().mockResolvedValue({
		provider: "VERCEL_GATEWAY",
		providerModelId: "google/gemini-3.1-flash-image-preview",
	});
	resolveOpenAiApiKey.mockReset().mockResolvedValue("");
	getImageModel.mockReset().mockReturnValue({ modelId: "gpt-image-2" });
	resolveProviderApiKey.mockReset();
	updateProviderLastUsed.mockReset().mockResolvedValue(1);
});

it("sends the default model to the direct Gemini client", async () => {
	const { GoogleGenAI } = await import("@google/genai");
	const generateContent = vi.fn().mockResolvedValue({ candidates: [] });
	vi.mocked(GoogleGenAI).mockImplementation(function () {
		return { models: { generateContent } } as never;
	});
	vi.stubEnv("GOOGLE_AI_STUDIO_API_KEY", "example-key");
	try {
		await generateImageActivity({
			prompt: "a boat",
			provider: "gemini",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(generateContent).toHaveBeenCalledWith(
			expect.objectContaining({ model: "gemini-nano-banana-2.1" }),
		);
	} finally {
		vi.unstubAllEnvs();
	}
});

describe("organization OpenAI image choices", () => {
	it("prefers OpenAI over a configured local image server", async () => {
		const local = await import("@repo/ai/local-models");
		const localConfig = vi
			.spyOn(local, "getLocalModelConfig")
			.mockReturnValue({
				model: "local-image",
				baseURL: "http://localhost",
			} as never);
		try {
			resolveImageModelChoice.mockResolvedValue({
				provider: "OPENAI_DIRECT",
				providerModelId: "gpt-image-2",
			});
			resolveOpenAiApiKey.mockResolvedValue("org-openai-key");
			const { generateImage } = await import("@repo/ai");
			vi.mocked(generateImage).mockResolvedValue({
				image: {
					uint8Array: new Uint8Array([1]),
					mediaType: "image/png",
				},
			} as never);
			const result = await generateImageActivity({
				prompt: "a boat",
				provider: "gateway",
				userId: "example-user",
				organizationId: "example-org",
			});
			expect(result).toMatchObject({
				success: true,
				provider: "openai",
				model: "gpt-image-2",
			});
		} finally {
			localConfig.mockRestore();
		}
	});
	it.each(["fal", "gemini"] as const)(
		"prefers OpenAI over the %s provider",
		async (provider) => {
			resolveImageModelChoice.mockResolvedValue({
				provider: "OPENAI_DIRECT",
				providerModelId: "gpt-image-2",
			});
			resolveOpenAiApiKey.mockResolvedValue("org-openai-key");
			const { generateImage } = await import("@repo/ai");
			vi.mocked(generateImage).mockResolvedValue({
				image: {
					uint8Array: new Uint8Array([1]),
					mediaType: "image/png",
				},
			} as never);
			const result = await generateImageActivity({
				prompt: "a boat",
				provider,
				userId: "example-user",
				organizationId: "example-org",
			});
			expect(result).toMatchObject({
				success: true,
				provider: "openai",
				model: "gpt-image-2",
			});
		},
	);
	it("prefers the saved OpenAI choice over a gateway model", async () => {
		const { createGateway, generateImage } = await import("@repo/ai");
		const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
		vi.mocked(createGateway).mockClear();
		vi.mocked(generateImage)
			.mockReset()
			.mockResolvedValue({
				image: {
					uint8Array: new Uint8Array([1]),
					mediaType: "image/png",
				},
			} as never);
		resolveImageModelChoice.mockResolvedValue({
			provider: "OPENAI_DIRECT",
			providerModelId: "gpt-image-2",
		});
		resolveOpenAiApiKey.mockResolvedValue("org-openai-key");
		const result = await generateImageActivity({
			prompt: "a boat",
			provider: "gateway",
			gatewayModel: "google/example",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(result).toMatchObject({
			success: true,
			provider: "openai",
			model: "gpt-image-2",
		});
		expect(getImageModel).toHaveBeenCalledWith(
			"gpt-image-2",
			expect.objectContaining({ apiKey: "org-openai-key" }),
		);
		expect(createGateway).not.toHaveBeenCalled();
		expect(infoLog).toHaveBeenCalledWith(
			"[ImageGeneration] Ignored gateway model:",
			"google/example",
		);
		infoLog.mockRestore();
	});
	it("fails closed when the saved image choice cannot be resolved", async () => {
		const { createGateway, generateImage, generateText } = await import(
			"@repo/ai"
		);
		vi.mocked(createGateway).mockClear();
		vi.mocked(generateImage).mockClear();
		vi.mocked(generateText).mockClear();
		const resolutionError = new Error(
			"image preference database unavailable",
		);
		const errorLog = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		resolveImageModelChoice.mockRejectedValue(resolutionError);

		const result = await generateImageActivity({
			prompt: "a paper boat",
			provider: "gateway",
			gatewayModel: "google/example",
			userId: "example-user",
			organizationId: "example-org",
		});

		expect(result).toMatchObject({
			success: false,
			provider: "gateway",
			error: "Unable to resolve the configured image model. Please try again or review Settings > AI Models.",
		});
		expect(errorLog).toHaveBeenCalledWith(
			"[ImageGeneration] Failed to resolve the configured image model:",
			resolutionError,
		);
		expect(createGateway).not.toHaveBeenCalled();
		expect(generateImage).not.toHaveBeenCalled();
		expect(generateText).not.toHaveBeenCalled();
		errorLog.mockRestore();
	});

	it("generates with the organization's OpenAI key and logs OPENAI_DIRECT", async () => {
		const { createGateway, generateImage } = await import("@repo/ai");
		vi.mocked(createGateway).mockClear();
		vi.mocked(generateImage)
			.mockReset()
			.mockResolvedValue({
				image: {
					uint8Array: new Uint8Array([1, 2, 3]),
					mediaType: "image/png",
				},
			} as never);
		logAiUsageAsync.mockReset();
		resolveImageModelChoice.mockResolvedValue({
			provider: "OPENAI_DIRECT",
			providerModelId: "gpt-image-2",
		});
		resolveOpenAiApiKey.mockResolvedValue("org-openai-key");
		const imageModel = { modelId: "gpt-image-2" };
		getImageModel.mockReturnValue(imageModel);

		const result = await generateImageActivity({
			prompt: "a paper boat",
			provider: "gateway",
			userId: "example-user",
			organizationId: "example-org",
		});

		expect(result).toMatchObject({
			success: true,
			provider: "openai",
			model: "gpt-image-2",
		});
		expect(resolveOpenAiApiKey).toHaveBeenCalledWith({
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(getImageModel).toHaveBeenCalledWith("gpt-image-2", {
			apiKey: "org-openai-key",
			provider: "OPENAI_DIRECT",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(generateImage).toHaveBeenCalledWith({
			model: imageModel,
			prompt: "a paper boat",
		});
		expect(createGateway).not.toHaveBeenCalled();
		expect(logAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "OPENAI_DIRECT",
				providerModelId: "gpt-image-2",
				success: true,
			}),
		);
	});

	it.each([
		["1:1", "1024x1024"],
		["3:2", "1536x1024"],
		["2:3", "1024x1536"],
		["3:4", "1024x1536"],
		["4:3", "1536x1024"],
		["4:5", "1024x1536"],
		["5:4", "1536x1024"],
		["9:16", "1024x1536"],
		["16:9", "1536x1024"],
	])(
		"maps gpt-image-2 aspect ratio %s to size %s",
		async (aspectRatio, size) => {
			const { generateImage } = await import("@repo/ai");
			vi.mocked(generateImage)
				.mockReset()
				.mockResolvedValue({
					image: {
						uint8Array: new Uint8Array([1, 2, 3]),
						mediaType: "image/png",
					},
				} as never);
			resolveImageModelChoice.mockResolvedValue({
				provider: "OPENAI_DIRECT",
				providerModelId: "gpt-image-2",
			});
			resolveOpenAiApiKey.mockResolvedValue("org-openai-key");

			await generateImageActivity({
				prompt: "a paper boat",
				provider: "gateway",
				aspectRatio,
				userId: "example-user",
				organizationId: "example-org",
			});

			expect(generateImage).toHaveBeenCalledWith(
				expect.objectContaining({ size }),
			);
		},
	);

	it.each([
		["1:1", "1024x1024"],
		["9:16", "1024x1792"],
		["16:9", "1792x1024"],
	])(
		"maps dall-e-3 aspect ratio %s to size %s",
		async (aspectRatio, size) => {
			const { generateImage } = await import("@repo/ai");
			vi.mocked(generateImage)
				.mockReset()
				.mockResolvedValue({
					image: {
						uint8Array: new Uint8Array([1, 2, 3]),
						mediaType: "image/png",
					},
				} as never);
			resolveImageModelChoice.mockResolvedValue({
				provider: "OPENAI_DIRECT",
				providerModelId: "dall-e-3",
			});
			resolveOpenAiApiKey.mockResolvedValue("org-openai-key");

			await generateImageActivity({
				prompt: "a paper boat",
				provider: "gateway",
				aspectRatio,
				userId: "example-user",
				organizationId: "example-org",
			});

			expect(generateImage).toHaveBeenCalledWith(
				expect.objectContaining({ size }),
			);
		},
	);

	it("keeps dall-e-2 square for a landscape request", async () => {
		const { generateImage } = await import("@repo/ai");
		vi.mocked(generateImage)
			.mockReset()
			.mockResolvedValue({
				image: {
					uint8Array: new Uint8Array([1, 2, 3]),
					mediaType: "image/png",
				},
			} as never);
		resolveImageModelChoice.mockResolvedValue({
			provider: "OPENAI_DIRECT",
			providerModelId: "dall-e-2",
		});
		resolveOpenAiApiKey.mockResolvedValue("org-openai-key");

		await generateImageActivity({
			prompt: "a paper boat",
			provider: "gateway",
			aspectRatio: "16:9",
			userId: "example-user",
			organizationId: "example-org",
		});

		expect(generateImage).toHaveBeenCalledWith(
			expect.objectContaining({ size: "1024x1024" }),
		);
	});

	it("refuses an empty organization OpenAI key without a platform fallback", async () => {
		const { generateImage } = await import("@repo/ai");
		vi.mocked(generateImage).mockClear();
		resolveImageModelChoice.mockResolvedValue({
			provider: "OPENAI_DIRECT",
			providerModelId: "gpt-image-2",
		});

		const result = await generateImageActivity({
			prompt: "a paper boat",
			provider: "gateway",
			userId: "example-user",
			organizationId: "example-org",
		});

		expect(result).toMatchObject({
			success: false,
			provider: "openai",
			error: expect.stringContaining(
				"Configure OpenAI in Settings → AI Providers",
			),
		});
		expect(getImageModel).not.toHaveBeenCalled();
		expect(generateImage).not.toHaveBeenCalled();
	});

	it("refuses DALL-E input-image editing", async () => {
		const { generateImage } = await import("@repo/ai");
		vi.mocked(generateImage).mockClear();
		resolveImageModelChoice.mockResolvedValue({
			provider: "OPENAI_DIRECT",
			providerModelId: "dall-e-3",
		});
		resolveOpenAiApiKey.mockResolvedValue("org-openai-key");

		const result = await generateImageActivity({
			prompt: "edit the paper boat",
			provider: "gateway",
			userId: "example-user",
			organizationId: "example-org",
			inputImagePath: "example-org/generated-images/example.png",
		});

		expect(result).toMatchObject({
			success: false,
			provider: "openai",
			error: "Image editing requires a GPT Image model.",
		});
		expect(getImageModel).not.toHaveBeenCalled();
		expect(generateImage).not.toHaveBeenCalled();
	});
});

it("uses the organization's Vercel connection when its default provider is not Vercel", async () => {
	const { createGateway, generateText, getRAGProviderConfig } = await import(
		"@repo/ai"
	);
	vi.mocked(createGateway).mockClear();
	vi.mocked(getRAGProviderConfig).mockResolvedValue({
		provider: "ANTHROPIC_DIRECT",
		apiKey: "anthropic-key",
	} as never);
	getAiProviderApiKeyByProvider.mockResolvedValue({
		provider: "VERCEL_GATEWAY",
		source: "organization",
		apiKey: "encrypted-org-gateway-key",
		configId: "gateway-config",
	});
	resolveProviderApiKey.mockResolvedValue("org-gateway-key");
	vi.mocked(generateText).mockResolvedValue({
		text: "example",
		files: [{ uint8Array: new Uint8Array([1]), mediaType: "image/png" }],
	} as never);

	const result = await generateImageActivity({
		prompt: "example image",
		provider: "gateway",
		userId: "example-user",
		organizationId: "example-org",
	});

	expect(result.success).toBe(true);
	expect(getAiProviderApiKeyByProvider).toHaveBeenCalledWith({
		userId: "example-user",
		organizationId: "example-org",
		provider: "VERCEL_GATEWAY",
	});
	expect(createGateway).toHaveBeenCalledWith({ apiKey: "org-gateway-key" });
	expect(updateProviderLastUsed).toHaveBeenCalledWith({
		configId: "gateway-config",
		source: "organization",
	});
});

it("uses the organization Vercel connection when default resolution reports no provider", async () => {
	const { createGateway, generateText, getRAGProviderConfig } = await import(
		"@repo/ai"
	);
	vi.mocked(createGateway).mockClear();
	vi.mocked(getRAGProviderConfig).mockRejectedValue(
		new AIProviderNotConfiguredError("no default provider"),
	);
	getAiProviderApiKeyByProvider.mockResolvedValue({
		provider: "VERCEL_GATEWAY",
		source: "organization",
		apiKey: "encrypted-org-gateway-key",
		configId: null,
	});
	resolveProviderApiKey.mockResolvedValue("org-gateway-key");
	vi.mocked(generateText).mockResolvedValue({
		text: "example",
		files: [{ uint8Array: new Uint8Array([1]), mediaType: "image/png" }],
	} as never);

	const result = await generateImageActivity({
		prompt: "example image",
		provider: "gateway",
		userId: "example-user",
		organizationId: "example-org",
	});

	expect(result.success).toBe(true);
	expect(createGateway).toHaveBeenCalledWith({ apiKey: "org-gateway-key" });
});

it.each([
	"Databricks token endpoint unavailable",
	"Default key decryption failed",
])(
	"uses the organization Vercel connection after default resolution fails: %s",
	async (message) => {
		const { createGateway, generateText, getRAGProviderConfig } =
			await import("@repo/ai");
		vi.mocked(createGateway).mockClear();
		vi.mocked(getRAGProviderConfig).mockRejectedValue(new Error(message));
		getAiProviderApiKeyByProvider.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
			source: "organization",
			apiKey: "encrypted-org-gateway-key",
			configId: null,
		});
		resolveProviderApiKey.mockResolvedValue("org-gateway-key");
		vi.mocked(generateText).mockResolvedValue({
			text: "example",
			files: [
				{ uint8Array: new Uint8Array([1]), mediaType: "image/png" },
			],
		} as never);

		const result = await generateImageActivity({
			prompt: "example image",
			provider: "gateway",
			userId: "example-user",
			organizationId: "example-org",
		});

		expect(result.success).toBe(true);
		expect(createGateway).toHaveBeenCalledWith({
			apiKey: "org-gateway-key",
		});
	},
);

it.each([
	["no row", "example-org", { provider: null, source: null, apiKey: null }],
	[
		"wrong provider",
		"example-org",
		{
			provider: "OPENAI_DIRECT",
			source: "organization",
			apiKey: "encrypted-key",
		},
	],
	[
		"wrong source",
		"example-org",
		{
			provider: "VERCEL_GATEWAY",
			source: "environment",
			apiKey: "encrypted-key",
		},
	],
	[
		"missing key",
		"example-org",
		{ provider: "VERCEL_GATEWAY", source: "organization", apiKey: null },
	],
	[
		"no organization",
		undefined,
		{ provider: null, source: null, apiKey: null },
	],
])(
	"preserves the default resolution error when the Vercel fallback has %s",
	async (_reason, organizationId, fallback) => {
		const { createGateway, getRAGProviderConfig } = await import(
			"@repo/ai"
		);
		vi.mocked(createGateway).mockClear();
		vi.mocked(getRAGProviderConfig).mockRejectedValue(
			new DatabricksOAuthError(
				"Databricks service-principal token exchange failed (status 401).",
				{ status: 401 },
			),
		);
		getAiProviderApiKeyByProvider.mockResolvedValue(fallback);
		resolveProviderApiKey.mockResolvedValue("vck_fallback_key");

		const result = await generateImageActivity({
			prompt: "example image",
			provider: "gateway",
			userId: "example-user",
			organizationId,
		});

		expect(result).toMatchObject({
			success: false,
			error: "Databricks service-principal token exchange failed (status 401).",
		});
		expect(resolveProviderApiKey).not.toHaveBeenCalled();
		expect(createGateway).not.toHaveBeenCalled();
	},
);

it.each(["lookup", "decryption"])(
	"sanitizes the organization Vercel %s error after default resolution fails",
	async (stage) => {
		const { getRAGProviderConfig } = await import("@repo/ai");
		vi.mocked(getRAGProviderConfig).mockRejectedValue(
			new Error("Databricks token endpoint unavailable"),
		);
		const fallbackError = new Error(
			"Organization gateway credential unavailable",
		);
		if (stage === "lookup") {
			getAiProviderApiKeyByProvider.mockRejectedValue(fallbackError);
		} else {
			getAiProviderApiKeyByProvider.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
				source: "organization",
				apiKey: "encrypted-org-gateway-key",
				configId: null,
			});
			resolveProviderApiKey.mockRejectedValue(fallbackError);
		}

		const result = await generateImageActivity({
			prompt: "example image",
			provider: "gateway",
			userId: "example-user",
			organizationId: "example-org",
		});

		expect(result).toMatchObject({
			success: false,
			error: "Couldn't load the organization's AI provider credentials. Check Settings → AI Providers.",
		});
	},
);

it.each(["user", "organization"])(
	"keeps the default %s Vercel credential ahead of a different organization key",
	async (source) => {
		const { createGateway, generateText, getRAGProviderConfig } =
			await import("@repo/ai");
		vi.mocked(createGateway).mockClear();
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			provider: "VERCEL_GATEWAY",
			apiKey: "default-gateway-key",
			source,
		} as never);
		getAiProviderApiKeyByProvider.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
			source: "organization",
			apiKey: "encrypted-org-gateway-key",
			configId: null,
		});
		resolveProviderApiKey.mockResolvedValue("org-gateway-key");
		vi.mocked(generateText).mockResolvedValue({
			text: "example",
			files: [
				{ uint8Array: new Uint8Array([1]), mediaType: "image/png" },
			],
		} as never);

		const result = await generateImageActivity({
			prompt: "example image",
			provider: "gateway",
			userId: "example-user",
			organizationId: "example-org",
		});

		expect(result.success).toBe(true);
		expect(createGateway).toHaveBeenCalledWith({
			apiKey: "default-gateway-key",
		});
		expect(getAiProviderApiKeyByProvider).not.toHaveBeenCalled();
	},
);

it("refuses a non-Vercel default when the organization has no Vercel connection", async () => {
	const { createGateway, getRAGProviderConfig } = await import("@repo/ai");
	vi.mocked(createGateway).mockClear();
	vi.mocked(getRAGProviderConfig).mockResolvedValue({
		provider: "ANTHROPIC_DIRECT",
		apiKey: "anthropic-key",
	} as never);

	const result = await generateImageActivity({
		prompt: "example image",
		provider: "gateway",
		userId: "example-user",
		organizationId: "example-org",
	});

	expect(result.success).toBe(false);
	expect(result.error).toContain("requires a VERCEL_GATEWAY connection");
	expect(createGateway).not.toHaveBeenCalled();
});

it("keeps the missing-key early return when neither provider lookup resolves", async () => {
	const { createGateway, getRAGProviderConfig } = await import("@repo/ai");
	vi.mocked(createGateway).mockClear();
	vi.mocked(getRAGProviderConfig).mockRejectedValue(
		new AIProviderNotConfiguredError("no default provider"),
	);

	const result = await generateImageActivity({
		prompt: "example image",
		provider: "gateway",
		userId: "example-user",
		organizationId: "example-org",
	});

	expect(result).toMatchObject({
		success: false,
		error: "AI Gateway API key not configured. Please configure it in Settings > AI Providers.",
	});
	expect(createGateway).not.toHaveBeenCalled();
});

it.each([
	[
		"provider",
		{
			provider: "OPENAI_DIRECT",
			source: "organization",
			apiKey: "encrypted-key",
		},
	],
	[
		"source",
		{
			provider: "VERCEL_GATEWAY",
			source: null,
			apiKey: "encrypted-platform-key",
		},
	],
	[
		"apiKey",
		{
			provider: "VERCEL_GATEWAY",
			source: "organization",
			apiKey: null,
		},
	],
])(
	"refuses an organization fallback with an invalid %s guard",
	async (_guard, fallback) => {
		const { createGateway, getRAGProviderConfig } = await import(
			"@repo/ai"
		);
		vi.mocked(createGateway).mockClear();
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			provider: "ANTHROPIC_DIRECT",
			apiKey: "anthropic-key",
		} as never);
		getAiProviderApiKeyByProvider.mockResolvedValue({
			configId: null,
			...fallback,
		});
		resolveProviderApiKey.mockResolvedValue("vck_fallback_key");

		const result = await generateImageActivity({
			prompt: "example image",
			provider: "gateway",
			userId: "example-user",
			organizationId: "example-org",
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("requires a VERCEL_GATEWAY connection");
		expect(resolveProviderApiKey).not.toHaveBeenCalled();
		expect(createGateway).not.toHaveBeenCalled();
	},
);

it("does not look up an organization connection without an organizationId", async () => {
	const { createGateway, getRAGProviderConfig } = await import("@repo/ai");
	vi.mocked(createGateway).mockClear();
	vi.mocked(getRAGProviderConfig).mockResolvedValue({
		provider: "ANTHROPIC_DIRECT",
		apiKey: "anthropic-key",
	} as never);

	const result = await generateImageActivity({
		prompt: "example image",
		provider: "gateway",
		userId: "example-user",
	});

	expect(result.success).toBe(false);
	expect(result.error).toContain("requires a VERCEL_GATEWAY connection");
	expect(getAiProviderApiKeyByProvider).not.toHaveBeenCalled();
	expect(createGateway).not.toHaveBeenCalled();
});

describe("generateImageActivity — usage marker (Fizzy #1894)", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("writes a success marker row for a gateway generation", async () => {
		const { generateText, getRAGProviderConfig } = await import("@repo/ai");
		resolveImageModelChoice.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
			providerModelId: "google/other-image",
		});
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			apiKey: "gateway-key",
			provider: "VERCEL_GATEWAY",
		} as never);
		vi.mocked(generateText).mockResolvedValue({
			text: "here is your boat",
			files: [
				{
					uint8Array: new Uint8Array([1, 2, 3]),
					mediaType: "image/png",
				},
			],
		} as never);

		const result = await runWithAiCallPurpose("compaction", () =>
			generateImageActivity({
				prompt: "a paper boat",
				provider: "gateway",
				gatewayModel: "google/gemini-3.1-flash-image",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);

		expect(result.success).toBe(true);
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			provider: "VERCEL_GATEWAY",
			callPurpose: "image-generation",
			providerModelId: "google/gemini-3.1-flash-image",
			taskType: "IMAGE",
			jobType: "image-generation",
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			success: true,
		});
	});

	it("writes a failure marker when the provider call throws", async () => {
		const { generateText, getRAGProviderConfig } = await import("@repo/ai");
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			apiKey: "stale-key",
			provider: "VERCEL_GATEWAY",
		} as never);
		vi.mocked(generateText).mockRejectedValue(
			new Error("Unauthenticated. Configure AI_GATEWAY_API_KEY"),
		);

		const result = await generateImageActivity({
			prompt: "a lighthouse",
			provider: "gateway",
			gatewayModel: "google/gemini-3.1-flash-image",
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(result.success).toBe(false);
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		const row = logAiUsageAsync.mock.calls[0][0];
		expect(row).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			taskType: "IMAGE",
			jobType: "image-generation",
			success: false,
			totalTokens: 0,
		});
		expect(row.errorMessage).toBe(
			"Vercel AI Gateway image generation failed. Try again.",
		);
	});
});

describe("image conversation attribution", () => {
	it.each([true, false])(
		"retains the Workspace origin on image success=%s",
		async (success) => {
			logAiUsageAsync.mockReset();
			const { generateText, getRAGProviderConfig } = await import(
				"@repo/ai"
			);
			vi.mocked(getRAGProviderConfig).mockResolvedValue({
				apiKey: "key-example",
				provider: "VERCEL_GATEWAY",
			} as never);
			if (success) {
				vi.mocked(generateText).mockResolvedValue({
					text: "boat",
					files: [
						{
							uint8Array: new Uint8Array([1]),
							mediaType: "image/png",
						},
					],
				} as never);
			} else {
				vi.mocked(generateText).mockRejectedValue(
					new Error("provider-example"),
				);
			}
			const usageOrigin = {
				projectId: "project-example",
				frameId: "frame-example",
				workflowExecutionId: "execution-example",
			};
			await generateImageActivity({
				prompt: "boat",
				provider: "gateway",
				userId: "user-example",
				usageOrigin,
			});
			expect(logAiUsageAsync).toHaveBeenCalledOnce();
			expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
				...usageOrigin,
				success,
				jobType: "image-generation",
				taskType: "IMAGE",
			});
		},
	);

	it.each(["conversation-example", undefined])(
		"records only the supplied conversation (%s)",
		async (usageConversationId) => {
			logAiUsageAsync.mockReset();
			const { generateText, getRAGProviderConfig } = await import(
				"@repo/ai"
			);
			vi.mocked(getRAGProviderConfig).mockResolvedValue({
				apiKey: "key-example",
				provider: "VERCEL_GATEWAY",
			} as never);
			vi.mocked(generateText).mockRejectedValue(
				new Error("provider-example"),
			);
			await generateImageActivity({
				prompt: "boat",
				provider: "gateway",
				userId: "user-example",
				usageConversationId,
			});
			expect(logAiUsageAsync.mock.calls[0][0].conversationId).toBe(
				usageConversationId,
			);
		},
	);

	it("records a generated image with the supplied conversation candidate before signing", async () => {
		recordChatMediaObject.mockClear();
		const { generateText, getRAGProviderConfig } = await import("@repo/ai");
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			apiKey: "key-example",
			provider: "VERCEL_GATEWAY",
		} as never);
		vi.mocked(generateText).mockResolvedValue({
			text: "boat",
			files: [
				{ uint8Array: new Uint8Array([1]), mediaType: "image/png" },
			],
		} as never);

		const result = await generateImageActivity({
			prompt: "boat",
			provider: "gateway",
			userId: "user-example",
			organizationId: "org-example",
			usageConversationId: "conversation-example",
		});

		expect(result.success).toBe(true);
		expect(recordChatMediaObject).toHaveBeenCalledWith({
			storageKey: expect.stringMatching(
				/^org-example\/generated-images\/\d+-[a-z0-9]+\.png$/,
			),
			kind: "GENERATED_IMAGE",
			userId: "user-example",
			organizationId: "org-example",
			conversationId: "conversation-example",
		});
	});

	it("throws when a generated upload cannot be recorded so the activity can retry", async () => {
		const { generateText, getRAGProviderConfig } = await import("@repo/ai");
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			apiKey: "key-example",
			provider: "VERCEL_GATEWAY",
		} as never);
		vi.mocked(generateText).mockResolvedValue({
			files: [
				{ uint8Array: new Uint8Array([1]), mediaType: "image/png" },
			],
		} as never);
		recordChatMediaObject.mockRejectedValueOnce(new Error("unavailable"));

		await expect(
			generateImageActivity({
				prompt: "boat",
				provider: "gateway",
				userId: "user-example",
			}),
		).rejects.toMatchObject({ name: "ChatMediaPersistenceError" });
	});
});

describe("input image access", () => {
	it("refuses a private peer inputImagePath before downloading or calling the model", async () => {
		resolveChatMediaAccess.mockResolvedValueOnce("deny");
		const { generateText, getRAGProviderConfig } = await import("@repo/ai");
		const { downloadFile } = await import("@repo/storage");
		vi.mocked(generateText).mockClear();
		vi.mocked(downloadFile).mockClear();
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			apiKey: "key-example",
			provider: "VERCEL_GATEWAY",
		} as never);

		const result = await generateImageActivity({
			prompt: "edit the image",
			provider: "gateway",
			userId: "example-viewer",
			organizationId: "example-org",
			inputImagePath:
				"example-org/generated-images/1794200000000-abc123xy.png",
		});

		expect(result).toMatchObject({
			success: false,
			error: "Input image is not available to the current user",
		});
		expect(downloadFile).not.toHaveBeenCalled();
		expect(generateText).not.toHaveBeenCalled();
	});
});

it.each(["OPENROUTER", "CLOUDFLARE_AI"])(
	"refuses %s keys before constructing a Vercel image client",
	async (provider) => {
		const { createGateway, getRAGProviderConfig } = await import(
			"@repo/ai"
		);
		vi.mocked(createGateway).mockClear();
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			provider,
			apiKey: "example-key",
			baseUrl: "https://example.com/v1",
		} as never);
		const result = await generateImageActivity({
			prompt: "example image",
			provider: "gateway",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("requires a VERCEL_GATEWAY connection");
		expect(createGateway).not.toHaveBeenCalled();
	},
);

it("accepts a Vercel key stored under OPENAI_DIRECT", async () => {
	const { createGateway, generateImage, generateText, getRAGProviderConfig } =
		await import("@repo/ai");
	vi.mocked(createGateway).mockClear();
	vi.mocked(getRAGProviderConfig).mockResolvedValue({
		provider: "OPENAI_DIRECT",
		apiKey: "vck_example_key",
	} as never);
	vi.mocked(generateText).mockResolvedValue({
		text: "example",
		files: [{ uint8Array: new Uint8Array([1]), mediaType: "image/png" }],
	} as never);
	vi.mocked(generateImage).mockResolvedValue({
		image: { base64: "aGk=", uint8Array: new Uint8Array([1]) },
	} as never);
	const result = await generateImageActivity({
		prompt: "example image",
		provider: "gateway",
		userId: "example-user",
		organizationId: "example-org",
	});
	expect(result.success).toBe(true);
	expect(createGateway).toHaveBeenCalledWith({ apiKey: "vck_example_key" });
});

describe("fixed provider failure messages", () => {
	for (const path of ["openai", "gateway-text", "gateway-image"] as const) {
		it.each([
			[
				401,
				"rejected the organization's credentials. Check Settings → AI Providers.",
			],
			[
				403,
				"rejected the organization's credentials. Check Settings → AI Providers.",
			],
			[429, "rate limit or quota reached. Try again later."],
			[400, "refused this request. Rephrase the prompt."],
			[500, "image generation failed. Try again."],
			[undefined, "image generation failed. Try again."],
		] as const)(`${path} sanitizes status %s`, async (status, message) => {
			const { generateImage, generateText, getRAGProviderConfig } =
				await import("@repo/ai");
			const raw =
				status === undefined
					? new Error(
							"Incorrect API key provided: sk-example-not-a-real-key",
						)
					: new APICallError({
							message:
								"Incorrect API key provided: sk-example-not-a-real-key",
							url: "https://example.com/images",
							requestBodyValues: {},
							statusCode: status,
						});
			const failure =
				status === 429
					? new RetryError({
							message:
								"Retries failed: sk-example-not-a-real-key",
							reason: "maxRetriesExceeded",
							errors: [raw],
						})
					: raw;
			resolveImageModelChoice.mockResolvedValue({
				provider:
					path === "openai" ? "OPENAI_DIRECT" : "VERCEL_GATEWAY",
				providerModelId:
					path === "gateway-text"
						? "google/gemini-3.1-flash-image-preview"
						: "gpt-image-2",
			});
			resolveOpenAiApiKey.mockResolvedValue(
				"example-organization-secret",
			);
			vi.mocked(getRAGProviderConfig).mockResolvedValue({
				provider: "VERCEL_GATEWAY",
				apiKey: "vck_example",
			} as never);
			vi.mocked(generateImage).mockRejectedValue(failure);
			vi.mocked(generateText).mockRejectedValue(failure);
			logAiUsageAsync.mockClear();
			const errorLog = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			try {
				const result = await generateImageActivity({
					prompt: "a paper boat",
					provider: "gateway",
					userId: "example-user",
					organizationId: "example-org",
				});
				expect(result).toMatchObject({
					success: false,
					error: `${path === "openai" ? "OpenAI" : "Vercel AI Gateway"} ${message}`,
				});
				expect(JSON.stringify(result)).not.toContain(
					"sk-example-not-a-real-key",
				);
				expect(
					JSON.stringify(logAiUsageAsync.mock.calls),
				).not.toContain("sk-example-not-a-real-key");
				expect(errorLog).toHaveBeenCalledWith(
					expect.any(String),
					failure,
				);
				expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
					"example-organization-secret",
				);
				expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
					"vck_example",
				);
			} finally {
				errorLog.mockRestore();
			}
		});
	}

	it.each([401, 429, 400, 500])(
		"sanitizes FAL response bodies for status %s",
		async (status) => {
			const { fetchCredentialsByProvider } = await import(
				"@repo/database"
			);
			vi.mocked(fetchCredentialsByProvider).mockResolvedValue({
				FAL_API_KEY: "example-key",
			} as never);
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					new Response(
						JSON.stringify({
							detail: "sk-example-not-a-real-key",
							message: "private request details",
						}),
						{ status },
					),
				),
			);
			const errorLog = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			try {
				const result = await generateImageActivity({
					prompt: "boat",
					provider: "fal",
					userId: "example-user",
				});
				expect(result.success).toBe(false);
				expect(result.error).toMatch(/^FAL /);
				expect(JSON.stringify(result)).not.toMatch(
					/sk-example|private request/,
				);
				expect(errorLog).toHaveBeenCalled();
			} finally {
				vi.unstubAllGlobals();
				errorLog.mockRestore();
			}
		},
	);
});

it.each(["gateway", "openai"])(
	"sanitizes non-Databricks %s credential resolution failures",
	async (path) => {
		const { getRAGProviderConfig, generateImage, generateText } =
			await import("@repo/ai");
		vi.mocked(generateImage).mockClear();
		vi.mocked(generateText).mockClear();
		const failure = Object.assign(new Error("sk-example-not-a-real-key"), {
			name: "DatabricksOAuthError",
			status: 401,
		});
		if (path === "openai") {
			resolveImageModelChoice.mockResolvedValue({
				provider: "OPENAI_DIRECT",
				providerModelId: "gpt-image-2",
			});
			resolveOpenAiApiKey.mockRejectedValue(failure);
		} else {
			vi.mocked(getRAGProviderConfig).mockRejectedValue(failure);
		}
		const result = await generateImageActivity({
			prompt: "a paper boat",
			provider: "gateway",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(result).toMatchObject({
			success: false,
			error: "Couldn't load the organization's AI provider credentials. Check Settings → AI Providers.",
		});
		expect(generateImage).not.toHaveBeenCalled();
		expect(generateText).not.toHaveBeenCalled();
	},
);

it.each(["gateway", "openai"])(
	"rethrows media, turn, then dispatch stops during %s credential resolution",
	async (path) => {
		const { getRAGProviderConfig } = await import("@repo/ai");
		for (const kind of ["media", "turn", "dispatch"]) {
			const failure =
				kind === "media"
					? new ChatMediaPersistenceError("Media persistence failed")
					: kind === "turn"
						? new CancelledFailure("Turn stopped")
						: new Error("Dispatch stopped");
			const dispatchStop =
				kind === "dispatch"
					? failure
					: new Error(
							"Dispatch must not override media or turn stops",
						);
			if (path === "openai") {
				resolveImageModelChoice.mockResolvedValue({
					provider: "OPENAI_DIRECT",
					providerModelId: "gpt-image-2",
				});
				resolveOpenAiApiKey.mockRejectedValue(failure);
			} else {
				vi.mocked(getRAGProviderConfig).mockRejectedValue(failure);
			}
			await expect(
				runWithDispatchGuard(
					{
						key: "example-turn",
						assertDispatchable: async () => undefined,
						abortSignal: () => undefined,
						rethrowIfStopped: () => {
							throw dispatchStop;
						},
					},
					() =>
						generateImageActivity({
							prompt: "a paper boat",
							provider: "gateway",
							userId: "example-user",
							organizationId: "example-org",
							turnScope: {
								turnId: "example-turn",
								executionId: "example-execution",
								userId: "example-user",
								organizationId: "example-org",
							},
						}),
				),
			).rejects.toBe(failure);
		}
	},
);

describe("GPT Image editing", () => {
	it.each(
		[
			"gpt-image-2",
			"gpt-image-2.6-sunburst",
			"gpt-image-2.6-flare",
		].flatMap((id) => [id, `openai/${id}`]),
	)("accepts %s", (id) => {
		expect(supportsInputImageEdits(id)).toBe(true);
	});
	it.each([
		"dall-e-3",
		"openai/dall-e-3",
		"gpt-image",
		"gpt-image-",
		"xgpt-image-2",
		"openai/gpt-image-2/extra",
		"google/gpt-image-2",
		"gpt-image-2!",
	])("rejects %s", (id) => {
		expect(supportsInputImageEdits(id)).toBe(false);
	});
	it.each([
		["VERCEL_GATEWAY", "openai/gpt-image-2.6-flare", true],
		["OPENAI_DIRECT", "gpt-image-2", true],
		["OPENAI_DIRECT", "dall-e-3", false],
		["VERCEL_GATEWAY", "google/imagen-4.0-generate-001", false],
	] as const)(
		"handles %s %s input without dropping it",
		async (provider, model, allowed) => {
			const { generateImage, getRAGProviderConfig } = await import(
				"@repo/ai"
			);
			vi.mocked(getRAGProviderConfig).mockResolvedValue({
				apiKey: "vck_example",
				provider: "VERCEL_GATEWAY",
			} as never);
			const { downloadFile } = await import("@repo/storage");
			const bytes = new Uint8Array([137, 80, 78, 71]);
			vi.mocked(downloadFile).mockResolvedValue({
				data: Buffer.from(bytes),
				contentType: "image/png",
			} as never);
			vi.mocked(generateImage)
				.mockReset()
				.mockResolvedValue({
					image: {
						uint8Array: new Uint8Array([1]),
						mediaType: "image/png",
					},
				} as never);
			resolveImageModelChoice.mockResolvedValue({
				provider,
				providerModelId: model,
			});
			resolveOpenAiApiKey.mockResolvedValue("example-key");
			resolveProviderApiKey.mockResolvedValue({
				apiKey: "vck_example",
				provider: "VERCEL_GATEWAY",
			});
			const result = await generateImageActivity({
				prompt: "same image",
				inputImagePath: "example-org/input.png",
				provider: "gateway",
				userId: "example-user",
				organizationId: "example-org",
			});
			expect(result.success).toBe(allowed);
			if (allowed) {
				expect(generateImage).toHaveBeenCalledWith(
					expect.objectContaining({
						model: expect.objectContaining({ modelId: model }),
						prompt: { images: [bytes], text: "same image" },
					}),
				);
			} else {
				expect(result.error).toBe(
					provider === "OPENAI_DIRECT"
						? "Image editing requires a GPT Image model."
						: "Image editing is available with Nano Banana and GPT Image models.",
				);
				expect(generateImage).not.toHaveBeenCalled();
			}
		},
	);
	it.each(["fal", "gemini"] as const)(
		"edits through a saved OpenAI choice when the tool asks for %s",
		async (toolProvider) => {
			const { generateImage } = await import("@repo/ai");
			const { downloadFile } = await import("@repo/storage");
			const bytes = new Uint8Array([137, 80, 78, 71]);
			vi.mocked(downloadFile).mockResolvedValue({
				data: Buffer.from(bytes),
				contentType: "image/png",
			} as never);
			vi.mocked(generateImage)
				.mockReset()
				.mockResolvedValue({
					image: {
						uint8Array: new Uint8Array([1]),
						mediaType: "image/png",
					},
				} as never);
			resolveImageModelChoice.mockResolvedValue({
				provider: "OPENAI_DIRECT",
				providerModelId: "gpt-image-2",
			});
			resolveOpenAiApiKey.mockResolvedValue("example-key");
			const result = await generateImageActivity({
				prompt: "same image",
				inputImagePath: "example-org/input.png",
				provider: toolProvider,
				userId: "example-user",
				organizationId: "example-org",
			});
			expect(result).toMatchObject({ success: true, provider: "openai" });
			expect(generateImage).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: { images: [bytes], text: "same image" },
				}),
			);
		},
	);
});

describe("input image review regressions", () => {
	for (const provider of ["VERCEL_GATEWAY", "OPENAI_DIRECT"] as const) {
		describe(provider, () => {
			beforeEach(async () => {
				const { generateImage, getRAGProviderConfig } = await import(
					"@repo/ai"
				);
				const { downloadFile } = await import("@repo/storage");
				vi.mocked(generateImage).mockClear();
				vi.mocked(downloadFile).mockReset();
				vi.mocked(getRAGProviderConfig).mockResolvedValue({
					apiKey: "vck_example",
					provider: "VERCEL_GATEWAY",
				} as never);
				resolveOpenAiApiKey.mockResolvedValue("example-key");
				resolveImageModelChoice.mockResolvedValue({
					provider,
					providerModelId:
						provider === "OPENAI_DIRECT"
							? "gpt-image-2"
							: "openai/gpt-image-2",
				});
			});
			const input = {
				prompt: "edit this image",
				provider: "gateway" as const,
				userId: "example-user",
				organizationId: "example-org",
				inputImagePath: "example-org/input.png",
			};
			it("refuses denied media before download and generation", async () => {
				const { generateImage } = await import("@repo/ai");
				const { downloadFile } = await import("@repo/storage");
				resolveChatMediaAccess.mockResolvedValue("deny");
				expect(await generateImageActivity(input)).toMatchObject({
					success: false,
					error: "Input image is not available to the current user",
				});
				expect(downloadFile).not.toHaveBeenCalled();
				expect(generateImage).not.toHaveBeenCalled();
			});
			it.each(["plain", "unscoped-turn"])(
				"returns download failure for %s errors",
				async (kind) => {
					const { generateImage } = await import("@repo/ai");
					const { downloadFile } = await import("@repo/storage");
					vi.mocked(downloadFile).mockRejectedValue(
						kind === "plain"
							? new Error("Download failed")
							: new CancelledFailure("Turn stopped"),
					);
					expect(await generateImageActivity(input)).toMatchObject({
						success: false,
						error: `Failed to download input image from storage: ${input.inputImagePath}`,
					});
					expect(generateImage).not.toHaveBeenCalled();
				},
			);
			it.each(["media", "turn", "dispatch"])(
				"rethrows %s during download with precedence",
				async (kind) => {
					const { generateImage } = await import("@repo/ai");
					const { downloadFile } = await import("@repo/storage");
					const failure =
						kind === "media"
							? new ChatMediaPersistenceError("Media failed")
							: kind === "turn"
								? new CancelledFailure("Turn stopped")
								: new Error("Dispatch stopped");
					vi.mocked(downloadFile).mockRejectedValue(failure);
					await expect(
						runWithDispatchGuard(
							{
								key: "example-turn",
								assertDispatchable: async () => undefined,
								abortSignal: () => undefined,
								rethrowIfStopped: () => {
									throw kind === "dispatch"
										? failure
										: new Error(
												"Dispatch must not override media or turn",
											);
								},
							},
							() =>
								generateImageActivity({
									...input,
									turnScope: {
										turnId: "example-turn",
										executionId: "example-execution",
										userId: input.userId,
										organizationId: input.organizationId,
									},
								}),
						),
					).rejects.toBe(failure);
					expect(generateImage).not.toHaveBeenCalled();
				},
			);
		});
	}
	it.each(["fal", "gemini"] as const)(
		"refuses %s input images before provider access and logs usage",
		async (provider) => {
			const { fetchCredentialsByProvider } = await import(
				"@repo/database"
			);
			const { generateImage, generateText } = await import("@repo/ai");
			vi.mocked(fetchCredentialsByProvider).mockClear();
			vi.mocked(generateImage).mockClear();
			vi.mocked(generateText).mockClear();
			logAiUsageAsync.mockClear();
			const { GoogleGenAI } = await import("@google/genai");
			vi.mocked(GoogleGenAI).mockClear();
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockRejectedValue(new Error("Unexpected provider call"));
			try {
				const result = await generateImageActivity({
					prompt: "edit image",
					provider,
					inputImagePath: "example-org/input.png",
					userId: "example-user",
					organizationId: "example-org",
				});
				expect(result).toMatchObject({
					success: false,
					provider,
					error: "Image editing isn't available with this provider. Use a Nano Banana or GPT Image model.",
				});
				expect(fetchCredentialsByProvider).not.toHaveBeenCalled();
				expect(fetchSpy).not.toHaveBeenCalled();
				expect(GoogleGenAI).not.toHaveBeenCalled();
				expect(generateImage).not.toHaveBeenCalled();
				expect(generateText).not.toHaveBeenCalled();
				expect(logAiUsageAsync).toHaveBeenCalled();
			} finally {
				fetchSpy.mockRestore();
			}
		},
	);
});

describe("gateway image routing", () => {
	it.each([
		["google/gemini-nano-banana-2.1", true],
		["google/gemini-3.1-flash-image", true],
		["google/gemini-3.1-flash-lite-image", true],
		["google/gemini-3-pro-image", true],
		["google/gemini-3.1-flash-image-preview", true],
		["google/gemini-3-pro-image-preview", true],
		["google/gemini-2.5-flash-image-preview", true],
		["openai/gpt-image-2.6-flare", false],
		["google/gemini-3.1-flash", false],
		["other/gemini-3-pro-image", false],
		["google/gemini-3-pro-image-text", false],
	])("routes %s through Gemini=%s", async (gatewayModel, gemini) => {
		const { generateText, generateImage, getRAGProviderConfig } =
			await import("@repo/ai");
		vi.mocked(generateText)
			.mockReset()
			.mockResolvedValue({
				files: [
					{ uint8Array: new Uint8Array([1]), mediaType: "image/png" },
				],
			} as never);
		vi.mocked(generateImage)
			.mockReset()
			.mockResolvedValue({
				image: { base64: "aGk=", uint8Array: new Uint8Array([1]) },
			} as never);
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			provider: "VERCEL_GATEWAY",
			apiKey: "example-key",
		} as never);
		const result = await generateImageActivity({
			prompt: "boat",
			provider: "gateway",
			gatewayModel,
			userId: "example-user",
		});
		expect(result.success).toBe(true);
		expect(generateText).toHaveBeenCalledTimes(gemini ? 1 : 0);
		expect(generateImage).toHaveBeenCalledTimes(gemini ? 0 : 1);
	});
});
