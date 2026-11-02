import { runWithAiCallPurpose } from "@repo/ai/lib/call-purpose-context";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { logAiUsageAsync, recordChatMediaObject, resolveChatMediaAccess } =
	vi.hoisted(() => ({
		logAiUsageAsync: vi.fn(),
		recordChatMediaObject: vi.fn(),
		resolveChatMediaAccess: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	fetchCredentialsByProvider: vi.fn(),
	logAiUsageAsync,
	resolveModel: vi.fn(),
	recordChatMediaObject,
	resolveChatMediaAccess,
}));
vi.mock("@repo/storage", () => ({
	deleteFile: vi.fn(),
	downloadFile: vi.fn(),
	getSignedUrl: vi.fn().mockResolvedValue("https://signed.example/image.png"),
	uploadFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@repo/ai", () => ({
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
	getRAGProviderConfig: vi.fn(),
}));

import { generateImageActivity } from "../image-generation";

beforeEach(() => {
	resolveChatMediaAccess.mockReset().mockResolvedValue("allow");
});

describe("generateImageActivity — usage marker (Fizzy #1894)", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("writes a success marker row for a gateway generation", async () => {
		const { generateText, getRAGProviderConfig } = await import("@repo/ai");
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
				gatewayModel: "google/gemini-3.1-flash-image-preview",
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
			providerModelId: "google/gemini-3.1-flash-image-preview",
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
			gatewayModel: "google/gemini-3.1-flash-image-preview",
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
		expect(row.errorMessage).toContain("Unauthenticated");
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
