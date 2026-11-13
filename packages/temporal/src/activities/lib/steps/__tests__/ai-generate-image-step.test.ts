import { DatabricksOAuthError } from "@repo/ai/lib/databricks-oauth";
import { runWithDispatchGuard } from "@repo/utils/dispatch-guard";
import { CancelledFailure } from "@temporalio/common";
import { APICallError, RetryError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	AIProviderNotConfiguredError,
	getAiProviderApiKeyByProvider,
	logAiUsageAsync,
	resolveProviderApiKey,
	updateProviderLastUsed,
} = vi.hoisted(() => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
	getAiProviderApiKeyByProvider: vi.fn(),
	logAiUsageAsync: vi.fn(),
	resolveProviderApiKey: vi.fn(),
	updateProviderLastUsed: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	logAiUsageAsync,
	fetchCredentialsByProvider: vi.fn(),
	getAiProviderApiKeyByProvider,
	resolveModel: vi.fn(),
	updateProviderLastUsed,
}));
vi.mock("@repo/storage", () => ({
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
	getAIModelWithMetadata: vi.fn(),
	getRAGProviderConfig: vi.fn(),
	resolveProviderApiKey,
}));

vi.mock("../fabric-enrichment", () => ({
	extractFabricConfig: () => ({}),
	applyFabricEnrichment: async () => ({
		fabricUsed: true,
		systemPrompt: "Enhance image prompts.",
	}),
}));

import {
	createGateway,
	generateImage,
	getAIModelWithMetadata,
	getRAGProviderConfig,
} from "@repo/ai";
import { ChatMediaPersistenceError } from "../../../chat-media";
import { executeAiGenerateImageStep } from "../ai-generate-image";

const PARAMS = {
	nodeConfig: {
		imagePrompt: "a paper boat",
		imageModel: "google/gemini-3.1-flash-image",
	},
	inputs: {},
	userId: "user-1",
	organizationId: "org-1",
	projectId: "proj-1",
	jobType: "workflow-builder" as const,
	executionId: "execution-example",
	frameId: "workspace",
};

beforeEach(() => {
	getAiProviderApiKeyByProvider.mockReset().mockResolvedValue({
		provider: null,
		source: null,
		apiKey: null,
	});
	resolveProviderApiKey.mockReset();
	updateProviderLastUsed.mockReset().mockResolvedValue(1);
});

it("uses the organization's Vercel connection when its default provider is not Vercel", async () => {
	const { createGateway, getRAGProviderConfig } = await import("@repo/ai");
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
	vi.mocked(generateImage).mockResolvedValue({
		image: { base64: "aGk=", uint8Array: new Uint8Array([1]) },
	} as never);

	const result = await executeAiGenerateImageStep(PARAMS);

	expect(result.success).toBe(true);
	expect(getAiProviderApiKeyByProvider).toHaveBeenCalledWith({
		userId: "user-1",
		organizationId: "org-1",
		provider: "VERCEL_GATEWAY",
	});
	expect(createGateway).toHaveBeenCalledWith({ apiKey: "org-gateway-key" });
	expect(updateProviderLastUsed).toHaveBeenCalledWith({
		configId: "gateway-config",
		source: "organization",
	});
});

it("uses the organization Vercel connection when default resolution reports no provider", async () => {
	const { createGateway, getRAGProviderConfig } = await import("@repo/ai");
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
	vi.mocked(generateImage).mockResolvedValue({
		image: { base64: "aGk=", uint8Array: new Uint8Array([1]) },
	} as never);

	const result = await executeAiGenerateImageStep(PARAMS);

	expect(result.success).toBe(true);
	expect(createGateway).toHaveBeenCalledWith({ apiKey: "org-gateway-key" });
});

it("refuses a non-Vercel default when the organization has no Vercel connection", async () => {
	const { createGateway, getRAGProviderConfig } = await import("@repo/ai");
	vi.mocked(createGateway).mockClear();
	vi.mocked(getRAGProviderConfig).mockResolvedValue({
		provider: "ANTHROPIC_DIRECT",
		apiKey: "anthropic-key",
	} as never);

	const result = await executeAiGenerateImageStep(PARAMS);

	expect(result.success).toBe(false);
	expect(result.error).toContain("requires a VERCEL_GATEWAY connection");
	expect(createGateway).not.toHaveBeenCalled();
});

it("refuses before client construction when neither provider lookup resolves", async () => {
	const { createGateway, getRAGProviderConfig } = await import("@repo/ai");
	vi.mocked(createGateway).mockClear();
	vi.mocked(getRAGProviderConfig).mockRejectedValue(
		new AIProviderNotConfiguredError("no default provider"),
	);

	const result = await executeAiGenerateImageStep(PARAMS);

	expect(result.success).toBe(false);
	expect(result.error).toContain("requires a VERCEL_GATEWAY connection");
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

		const result = await executeAiGenerateImageStep(PARAMS);

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

	const result = await executeAiGenerateImageStep({
		...PARAMS,
		organizationId: undefined,
	});

	expect(result.success).toBe(false);
	expect(result.error).toContain("requires a VERCEL_GATEWAY connection");
	expect(getAiProviderApiKeyByProvider).not.toHaveBeenCalled();
	expect(createGateway).not.toHaveBeenCalled();
});

describe("executeAiGenerateImageStep — usage markers (Fizzy #1894)", () => {
	beforeEach(() => {
		logAiUsageAsync.mockReset();
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			apiKey: "gateway-key",
			provider: "VERCEL_GATEWAY",
		} as never);
	});

	it("records a success marker carrying the pipeline label and project", async () => {
		vi.mocked(generateImage).mockResolvedValue({
			image: { base64: "aGk=", uint8Array: new Uint8Array([1]) },
		} as never);

		const result = await executeAiGenerateImageStep(PARAMS);

		expect(result.success).toBe(true);
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			provider: "VERCEL_GATEWAY",
			providerModelId: "google/gemini-3.1-flash-image",
			taskType: "IMAGE",
			jobType: "workflow-builder",
			workflowExecutionId: "execution-example",
			frameId: "workspace",
			featureKey: "workflow",
			success: true,
			totalTokens: 0,
		});
	});

	it("records a failure marker when the provider rejects", async () => {
		vi.mocked(generateImage).mockRejectedValue(
			new Error("gateway unavailable"),
		);

		const result = await executeAiGenerateImageStep(PARAMS);

		expect(result.success).toBe(false);
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		const row = logAiUsageAsync.mock.calls[0][0];
		expect(row).toMatchObject({
			taskType: "IMAGE",
			jobType: "workflow-builder",
			success: false,
		});
		expect(row.errorMessage).toBe(
			"Vercel AI Gateway image generation failed. Try again.",
		);
	});

	it("records a failure marker when the provider returns no image", async () => {
		vi.mocked(generateImage).mockResolvedValue({} as never);

		const result = await executeAiGenerateImageStep(PARAMS);

		expect(result.success).toBe(false);
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			jobType: "workflow-builder",
			success: false,
			errorMessage: "No image generated",
		});
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
		const result = await executeAiGenerateImageStep(PARAMS);
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
	const result = await executeAiGenerateImageStep(PARAMS);
	expect(result.success).toBe(true);
	expect(createGateway).toHaveBeenCalledWith({ apiKey: "vck_example_key" });
});

it.each([
	[
		401,
		"rejected the organization's credentials. Check Settings → AI Providers.",
	],
	[429, "rate limit or quota reached. Try again later."],
	[400, "refused this request. Rephrase the prompt."],
	[undefined, "image generation failed. Try again."],
] as const)(
	"sanitizes step provider failure status %s",
	async (status, message) => {
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			provider: "VERCEL_GATEWAY",
			apiKey: "vck_example",
		} as never);
		const raw = new APICallError({
			message: "sk-example-not-a-real-key",
			url: "https://example.com/images",
			requestBodyValues: {},
			statusCode: status,
		});
		const failure =
			status === 429
				? new RetryError({
						message: "sk-example-not-a-real-key",
						reason: "maxRetriesExceeded",
						errors: [raw],
					})
				: raw;
		vi.mocked(generateImage).mockRejectedValue(failure);
		logAiUsageAsync.mockClear();
		const errorLog = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		try {
			const result = await executeAiGenerateImageStep(PARAMS);
			expect(result).toMatchObject({
				success: false,
				error: `Vercel AI Gateway ${message}`,
			});
			expect(JSON.stringify(logAiUsageAsync.mock.calls)).not.toContain(
				"sk-example-not-a-real-key",
			);
			expect(errorLog).toHaveBeenCalledWith(expect.any(String), failure);
		} finally {
			errorLog.mockRestore();
		}
	},
);

it.each([
	[
		"Databricks",
		new DatabricksOAuthError(
			"Databricks service-principal token exchange failed (status 401).",
			{ status: 401 },
		),
		"Databricks service-principal token exchange failed (status 401).",
	],
	[
		"unclassified",
		Object.assign(new Error("sk-example-not-a-real-key"), {
			name: "DatabricksOAuthError",
			status: 401,
		}),
		"Couldn't load the organization's AI provider credentials. Check Settings → AI Providers.",
	],
])(
	"reports %s credential resolution separately from the image call",
	async (_name, failure, message) => {
		vi.mocked(getRAGProviderConfig).mockRejectedValue(failure);
		vi.mocked(generateImage).mockClear();
		const result = await executeAiGenerateImageStep(PARAMS);
		expect(result).toMatchObject({ success: false, error: message });
		expect(generateImage).not.toHaveBeenCalled();
	},
);

it("does not attribute model preparation failures to the image provider", async () => {
	vi.mocked(getRAGProviderConfig).mockResolvedValue({
		provider: "VERCEL_GATEWAY",
		apiKey: "vck_example",
	} as never);
	vi.mocked(createGateway).mockImplementationOnce(() => {
		throw Object.assign(new Error("sk-example-not-a-real-key"), {
			statusCode: 401,
		});
	});
	vi.mocked(generateImage).mockClear();
	expect(await executeAiGenerateImageStep(PARAMS)).toMatchObject({
		success: false,
		error: "Couldn't prepare image generation. Try again.",
	});
	expect(generateImage).not.toHaveBeenCalled();
});

it.each(["credentials", "enhancement", "image", "preparation"])(
	"rethrows media, turn, then dispatch stops at the %s boundary",
	async (stage) => {
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
			vi.mocked(getRAGProviderConfig).mockResolvedValue({
				provider: "VERCEL_GATEWAY",
				apiKey: "vck_example",
			} as never);
			vi.mocked(generateImage).mockResolvedValue({
				image: { base64: "aGk=" },
			} as never);
			if (stage === "credentials") {
				vi.mocked(getRAGProviderConfig).mockRejectedValue(failure);
			} else if (stage === "enhancement") {
				vi.mocked(getAIModelWithMetadata).mockRejectedValue(failure);
			} else if (stage === "image") {
				vi.mocked(generateImage).mockRejectedValue(failure);
			} else {
				vi.mocked(createGateway).mockImplementationOnce(() => {
					throw failure;
				});
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
						executeAiGenerateImageStep({
							...PARAMS,
							nodeConfig: {
								...PARAMS.nodeConfig,
								enhancePrompt: stage === "enhancement",
							},
						}),
				),
			).rejects.toBe(failure);
		}
	},
);
