import { beforeEach, describe, expect, it, vi } from "vitest";

const { logAiUsageAsync } = vi.hoisted(() => ({ logAiUsageAsync: vi.fn() }));

vi.mock("@repo/database", () => ({ logAiUsageAsync }));
vi.mock("@repo/ai", () => ({
	getSystemRAGProviderConfig: vi.fn().mockResolvedValue({
		apiKey: "test-key",
		provider: "OPENAI_DIRECT",
		baseUrl: null,
		enabledProviders: [],
		source: "user",
		deploymentName: null,
	}),
}));
vi.mock("@repo/observability", () => ({
	withProviderBreaker: (
		_provider: string,
		_surface: string,
		fn: () => Promise<unknown>,
	) => fn(),
}));
vi.mock("ai", () => ({
	experimental_transcribe: vi.fn(),
}));
vi.mock("../executor", () => ({
	getFabricAIMode: () => "hybrid",
	executeFabricPattern: vi.fn(),
}));

import { experimental_transcribe } from "ai";
import { transcribeAudio } from "../transcription";

const AUDIO = Buffer.from("fake-audio-bytes");

describe("transcribeAudio — usage marker (Fizzy #1894)", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("writes a success marker for a hybrid-mode transcription", async () => {
		vi.mocked(experimental_transcribe).mockResolvedValue({
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
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			success: true,
			errorMessage: undefined,
		});
	});

	it("writes a failure marker when the provider call throws", async () => {
		vi.mocked(experimental_transcribe).mockRejectedValue(
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
