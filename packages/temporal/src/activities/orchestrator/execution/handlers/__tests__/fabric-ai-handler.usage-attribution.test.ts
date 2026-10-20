/**
 * FabricAiHandler — usage attribution.
 *
 * A plan step, or an Advisor catalog call, that runs a Fabric pattern,
 * analysis or transcription hands the step's conversation to the Fabric AI
 * activity, so the model call's usage row records the chat. A step with no
 * conversation passes none, and never the execution ID.
 *
 * Mock set follows `planner-step-turn-stop.test.ts`; the Fabric AI
 * activities are replaced at their module boundary.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	image: vi.fn(async () => ({
		success: true,
		imageUrl: "https://example.com/image.png",
	})),
	speech: vi.fn(async () => ({ ok: true, audio: Buffer.from("audio") })),
	fabricAi: {
		analyzeYouTubeVideo: vi.fn(),
		scrapeAndAnalyzeActivity: vi.fn(),
		searchAndAnalyzeActivity: vi.fn(),
		executeFabricPattern: vi.fn(),
		transcribeAudioActivity: vi.fn(),
	},
}));

vi.mock("../../../../image-generation", () => ({
	generateImageActivity: h.image,
}));
vi.mock("../../../../../lib/text-to-speech", () => ({
	synthesizeToolSpeech: h.speech,
}));
vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: vi.fn(),
	fetchCredentialsByIdAndProviderInTenant: vi.fn(),
	fetchCredentialsByProvider: vi.fn(),
	logAiUsageAsync: vi.fn(),
	db: {},
}));
vi.mock("@repo/ai", () => ({
	AUDIO_PROVIDER_REQUIRED: { textToSpeech: "text-to-speech refused" },
	generateText: vi.fn(),
	resolveOpenAiApiKey: vi.fn(),
}));
vi.mock("@repo/fabric-ai", () => ({ createFabricClient: vi.fn(() => ({})) }));
vi.mock("@repo/storage", () => ({ uploadFile: vi.fn() }));
vi.mock("../../../../fabric-ai", () => h.fabricAi);
vi.mock("../../../utils/partykit-publisher", () => ({
	publishStepProgress: vi.fn(async () => undefined),
	publishStepStart: vi.fn(async () => undefined),
	publishToolStart: vi.fn(async () => undefined),
	publishToolComplete: vi.fn(async () => undefined),
}));
vi.mock("../../../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(async () => null),
}));
vi.mock("../../../../shared/frame-service", () => ({}));

import type { ExecuteStepInput } from "../../../types";
import { FabricAiHandler } from "../fabric-ai-handler";

const TOOLS: Array<[string, keyof typeof h.fabricAi, Record<string, unknown>]> =
	[
		[
			"fabric_analyze_youtube",
			"analyzeYouTubeVideo",
			{ url: "https://www.youtube.com/watch?v=example" },
		],
		[
			"fabric_scrape_and_analyze",
			"scrapeAndAnalyzeActivity",
			{ url: "https://example.com" },
		],
		[
			"fabric_search_and_analyze",
			"searchAndAnalyzeActivity",
			{ query: "q" },
		],
		["fabric_pattern", "executeFabricPattern", { input: "Some text" }],
		[
			"fabric_transcribe_audio",
			"transcribeAudioActivity",
			{ fileContent: "AAAA", fileName: "meeting.mp3" },
		],
	];

function stepInput(
	toolName: string,
	inputs: Record<string, unknown>,
	overrides: Partial<ExecuteStepInput> = {},
): ExecuteStepInput {
	return {
		step: {
			id: "s1",
			description: `Run ${toolName}`,
			type: "api",
			status: "in_progress",
			order: 1,
			app: toolName,
			executor: toolName,
			inputs,
		},
		message: "",
		systemPrompt: "",
		variables: {},
		userId: "user-1",
		organizationId: "org-1",
		executionId: "exec-1",
		executionMode: "iterative",
		totalSteps: 1,
		stepIndex: 1,
		previousStepResults: [],
		...overrides,
	};
}

function run(input: ExecuteStepInput) {
	return new FabricAiHandler().execute({
		input,
		variables: {},
		toolCalls: [],
		startTime: Date.now(),
	});
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	for (const fn of Object.values(h.fabricAi)) {
		fn.mockReset();
		fn.mockResolvedValue({
			success: true,
			output: "o",
			analysis: "a",
			transcript: "t",
			durationMs: 1,
		});
	}
});

describe("FabricAiHandler — usage attribution", () => {
	for (const [toolName, activity, inputs] of TOOLS) {
		it(`${toolName} passes the step's conversation to ${activity}`, async () => {
			const result = await run(
				stepInput(toolName, inputs, { conversationId: "conv-1" }),
			);

			expect(result.handled).toBe(true);
			expect(h.fabricAi[activity].mock.calls[0][0]).toMatchObject({
				userId: "user-1",
				organizationId: "org-1",
				conversationId: "conv-1",
			});
		});

		it(`${toolName} passes no conversation without one, never the execution ID`, async () => {
			await run(stepInput(toolName, inputs));

			const request = h.fabricAi[activity].mock.calls[0][0];
			expect(request).not.toHaveProperty("conversationId");
			expect(JSON.stringify(request)).not.toContain("exec-1");
		});
	}
});

describe("Fabric step media usage", () => {
	it.each(["conversation-example", undefined])(
		"passes only the step conversation to media (%s)",
		async (conversationId) => {
			h.image.mockClear();
			h.speech.mockClear();
			await run(
				stepInput(
					"fabric_generate_image",
					{ prompt: "boat" },
					{ conversationId, executionId: "execution-example" },
				),
			);
			expect(
				(
					h.image.mock.calls[0] as unknown as [
						{ usageConversationId?: string },
					]
				)[0].usageConversationId,
			).toBe(conversationId);
			await run(
				stepInput(
					"fabric_text_to_speech",
					{ text: "hello" },
					{ conversationId, executionId: "execution-example" },
				),
			);
			expect(
				(
					h.speech.mock.calls[0] as unknown as [
						{ usageConversationId?: string },
					]
				)[0].usageConversationId,
			).toBe(conversationId);
		},
	);
});
