import { beforeEach, describe, expect, it, vi } from "vitest";

const { logAiUsageAsync } = vi.hoisted(() => ({ logAiUsageAsync: vi.fn() }));

vi.mock("@repo/database", () => ({
	fetchCredentialsByProvider: vi.fn(),
	logAiUsageAsync,
	resolveModel: vi.fn(),
}));
vi.mock("@repo/storage", () => ({
	downloadFile: vi.fn(),
	getSignedUrl: vi.fn().mockResolvedValue("https://signed.example/image.png"),
	uploadFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@repo/ai", () => ({
	createGateway: () => {
		const gateway = vi.fn((model: string) => ({ modelId: model }));
		(
			gateway as unknown as { imageModel: (m: string) => unknown }
		).imageModel = (m: string) => ({ modelId: m });
		return gateway;
	},
	experimental_generateImage: vi.fn(),
	generateText: vi.fn(),
	getRAGProviderConfig: vi.fn(),
}));

import { generateImageActivity } from "../image-generation";

describe("generateImageActivity — usage marker (Fizzy #1894)", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("writes a success marker row for a gateway generation", async () => {
		const { generateText, getRAGProviderConfig } = await import("@repo/ai");
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			apiKey: "gateway-key",
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

		const result = await generateImageActivity({
			prompt: "a paper boat",
			provider: "gateway",
			gatewayModel: "google/gemini-3.1-flash-image-preview",
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(result.success).toBe(true);
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			provider: "VERCEL_GATEWAY",
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
