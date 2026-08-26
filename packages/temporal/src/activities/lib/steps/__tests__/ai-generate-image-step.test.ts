import { beforeEach, describe, expect, it, vi } from "vitest";

const { logAiUsageAsync } = vi.hoisted(() => ({ logAiUsageAsync: vi.fn() }));

vi.mock("@repo/database", () => ({
	logAiUsageAsync,
	fetchCredentialsByProvider: vi.fn(),
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
	getAIModelWithMetadata: vi.fn(),
	getRAGProviderConfig: vi.fn(),
}));

import {
	experimental_generateImage as generateImage,
	getRAGProviderConfig,
} from "@repo/ai";
import { executeAiGenerateImageStep } from "../ai-generate-image";

const PARAMS = {
	nodeConfig: {
		imagePrompt: "a paper boat",
		imageModel: "google/gemini-3.1-flash-image-preview",
	},
	inputs: {},
	userId: "user-1",
	organizationId: "org-1",
	projectId: "proj-1",
	jobType: "workflow-builder" as const,
};

describe("executeAiGenerateImageStep — usage markers (Fizzy #1894)", () => {
	beforeEach(() => {
		logAiUsageAsync.mockReset();
		vi.mocked(getRAGProviderConfig).mockResolvedValue({
			apiKey: "gateway-key",
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
			providerModelId: "google/gemini-3.1-flash-image-preview",
			taskType: "IMAGE",
			jobType: "workflow-builder",
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
		expect(row.errorMessage).toContain("gateway unavailable");
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
