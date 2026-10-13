import { beforeEach, describe, expect, it, vi } from "vitest";

const { logAiUsageAsync, getRAGProviderConfig, getSystemRAGProviderConfig } =
	vi.hoisted(() => ({
		logAiUsageAsync: vi.fn(),
		getRAGProviderConfig: vi.fn(),
		getSystemRAGProviderConfig: vi.fn(),
	}));

const TENANT_PROVIDER = {
	apiKey: "test-key",
	provider: "OPENAI_DIRECT",
	baseUrl: null,
	enabledProviders: [],
	source: "organization",
	deploymentName: null,
};

vi.mock("@repo/database", () => ({ logAiUsageAsync }));
vi.mock("@repo/ai", async () => {
	const { AUDIO_PROVIDER_REQUIRED } = await vi.importActual<
		typeof import("@repo/ai/lib/openai-provider-key")
	>("@repo/ai/lib/openai-provider-key");
	class AIProviderNotConfiguredError extends Error {}
	return {
		AIProviderNotConfiguredError,
		AUDIO_PROVIDER_REQUIRED,
		getRAGProviderConfig,
		// The platform-key resolver: transcription must never reach it.
		getSystemRAGProviderConfig,
	};
});
vi.mock("@repo/observability", () => ({
	withProviderBreaker: (
		_provider: string,
		_surface: string,
		fn: () => Promise<unknown>,
	) => fn(),
}));
vi.mock("ai", () => ({
	transcribe: vi.fn(),
}));
vi.mock("../executor", () => ({
	getFabricAIMode: () => "hybrid",
	executeFabricPattern: vi.fn(),
}));

import {
	AIProviderNotConfiguredError,
	AUDIO_PROVIDER_REQUIRED,
} from "@repo/ai";
import { transcribe } from "ai";
import { transcribeAudio } from "../transcription";

const AUDIO = Buffer.from("fake-audio-bytes");

describe("transcribeAudio — usage marker (Fizzy #1894)", () => {
	beforeEach(() => {
		logAiUsageAsync.mockReset();
		vi.mocked(transcribe).mockReset();
		getRAGProviderConfig.mockReset().mockResolvedValue(TENANT_PROVIDER);
		getSystemRAGProviderConfig.mockReset();
	});

	it("writes a success marker for a hybrid-mode transcription", async () => {
		vi.mocked(transcribe).mockResolvedValue({
			text: "hello world",
			language: "en",
			durationInSeconds: 3,
			segments: [],
			warnings: [],
			responses: [],
			providerMetadata: {},
		} as never);

		const result = await transcribeAudio(AUDIO, "meeting.mp3", {
			userContext: { userId: "user-1", organizationId: "org-1" },
		});

		expect(result.success).toBe(true);
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			taskType: "AUDIO",
			jobType: "transcription",
			featureKey: "transcription",
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			success: true,
			errorMessage: undefined,
		});
	});

	it("writes a failure marker when the provider call throws", async () => {
		vi.mocked(transcribe).mockRejectedValue(
			new Error("provider auth failed"),
		);

		const result = await transcribeAudio(AUDIO, "meeting.mp3", {
			userContext: { userId: "user-1", organizationId: "org-1" },
		});

		expect(result.success).toBe(false);
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		const row = logAiUsageAsync.mock.calls[0][0];
		expect(row).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			taskType: "AUDIO",
			jobType: "transcription",
			featureKey: "transcription",
			success: false,
		});
		expect(row.errorMessage).toContain("provider auth failed");
	});

	it("does not write a marker when validation rejects the file before any AI call", async () => {
		const result = await transcribeAudio(AUDIO, "notes.txt", {
			userContext: { userId: "user-1" },
		});

		expect(result.success).toBe(false);
		expect(logAiUsageAsync).not.toHaveBeenCalled();
	});
});

describe("transcribeAudio — never on Fabric's own key", () => {
	beforeEach(() => {
		logAiUsageAsync.mockReset();
		vi.mocked(transcribe).mockReset();
		getRAGProviderConfig.mockReset();
		getSystemRAGProviderConfig.mockReset();
	});

	it("refuses with the provider message when the organization has no provider", async () => {
		getRAGProviderConfig.mockRejectedValue(
			new AIProviderNotConfiguredError("No AI provider configured."),
		);

		const result = await transcribeAudio(AUDIO, "meeting.mp3", {
			userContext: { userId: "user-1", organizationId: "org-1" },
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe(AUDIO_PROVIDER_REQUIRED.transcription);
		expect(transcribe).not.toHaveBeenCalled();
		expect(getSystemRAGProviderConfig).not.toHaveBeenCalled();
	});

	it("transcribes on the organization's own key, resolved tenant-only", async () => {
		getRAGProviderConfig.mockResolvedValue(TENANT_PROVIDER);
		vi.mocked(transcribe).mockResolvedValue({
			text: "hello",
			segments: [],
			warnings: [],
			responses: [],
			providerMetadata: {},
		} as never);

		const result = await transcribeAudio(AUDIO, "meeting.mp3", {
			userContext: { userId: "user-1", organizationId: "org-1" },
		});

		expect(result.success).toBe(true);
		expect(getRAGProviderConfig).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(getSystemRAGProviderConfig).not.toHaveBeenCalled();
	});

	it("full mode transcribes on the tenant's provider, not Fabric AI's keys", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		getRAGProviderConfig.mockRejectedValue(
			new AIProviderNotConfiguredError("No AI provider configured."),
		);

		const result = await transcribeAudio(AUDIO, "meeting.mp3", {
			mode: "full",
			userContext: { userId: "user-1", organizationId: "org-1" },
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe(AUDIO_PROVIDER_REQUIRED.transcription);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});
