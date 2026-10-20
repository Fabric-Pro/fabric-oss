/**
 * `checkCompletionClaimActivity`: does a reply from a turn that called no tool
 * claim an action was done?
 *
 * The organization's typed decision model answers first (one boolean
 * question, the `advisor_completion_claim_judge` prompt as its instructions);
 * a SIMPLE-tier language model answers only when no decision model is
 * available or its answer is uncertain. A judge that cannot answer reports no
 * claim, so the reply stands; a turn stop is rethrown.
 *
 * The AI SDK, the model factory and the Prompt Library are faked; the prompt
 * resolution and rendering are real, so the seeded bodies are what the judge
 * and the turn receive when nothing is bound.
 */

import {
	COMPLETION_CLAIM_CORRECTION_FALLBACK_BODY,
	COMPLETION_CLAIM_JUDGE_FALLBACK_BODY,
} from "@repo/utils/completion-claim-prompts";
import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	decide: vi.fn(),
	getDecisionModel: vi.fn(),
	getLanguageModel: vi.fn(),
	generateText: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	trackUsage: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	createDecisionCapture: () => ({ run: (fn: () => unknown) => fn() }),
	experimental_decide: h.decide,
	getAIDecisionModelWithMetadata: h.getDecisionModel,
	getAIModelWithMetadata: h.getLanguageModel,
	recordDecisionOutcome: vi.fn(),
}));
vi.mock("ai", () => ({ generateText: h.generateText }));
vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: h.getBoundPromptForAgent,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checkCompletionClaimActivity } from "../check-completion-claim";

const INPUT = {
	userId: "user-example-1",
	organizationId: "org-example-1",
	projectId: "project-example-1",
	conversationId: "conversation-example-1",
	frameId: "frame-example-1",
	userRequest:
		"Every Monday at 08:00, publish a status page here. Run it once now too.",
	reply: "Done — I previously set this up. Also ran once immediately.",
};

function decisionAnswer(probability: number) {
	h.decide.mockResolvedValue({
		answers: { claimsAction: { probability } },
		usage: { inputTokens: 300, outputTokens: 2 },
	});
}

function languageAnswer(text: string) {
	h.generateText.mockResolvedValue({
		text,
		usage: { inputTokens: 400, outputTokens: 1 },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	h.getBoundPromptForAgent.mockResolvedValue(null);
	h.getDecisionModel.mockResolvedValue({
		model: { modelId: "decision-model" },
		trackUsage: h.trackUsage,
	});
	h.getLanguageModel.mockResolvedValue({
		model: { modelId: "simple-model" },
	});
});

describe("with a decision model", () => {
	it("finds a confident claim and returns the correction for the next round", async () => {
		decisionAnswer(0.97);

		const result = await checkCompletionClaimActivity(INPUT);

		expect(result).toEqual({
			unbackedClaim: true,
			correction: COMPLETION_CLAIM_CORRECTION_FALLBACK_BODY,
			judgedBy: "decision",
			usage: { inputTokens: 300, outputTokens: 2 },
		});
		expect(h.decide).toHaveBeenCalledWith(
			expect.objectContaining({
				state: { userRequest: INPUT.userRequest, reply: INPUT.reply },
				questions: {
					claimsAction: {
						type: "boolean",
						instructions: COMPLETION_CLAIM_JUDGE_FALLBACK_BODY,
					},
				},
			}),
		);
		expect(h.getDecisionModel).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-example-1",
				featureKey: "chat-agent",
				conversationId: "conversation-example-1",
				frameId: "frame-example-1",
			}),
		);
		expect(h.trackUsage).toHaveBeenCalled();
		expect(h.generateText).not.toHaveBeenCalled();
	});

	it("clears a confident no without asking a language model", async () => {
		decisionAnswer(0.04);

		const result = await checkCompletionClaimActivity(INPUT);

		expect(result.unbackedClaim).toBe(false);
		expect(result.correction).toBeUndefined();
		expect(h.generateText).not.toHaveBeenCalled();
	});

	it("asks the language model when the decision is uncertain, and charges both", async () => {
		decisionAnswer(0.5);
		languageAnswer("YES");

		const result = await checkCompletionClaimActivity(INPUT);

		expect(result).toMatchObject({
			unbackedClaim: true,
			judgedBy: "language",
			usage: { inputTokens: 700, outputTokens: 3 },
		});
		expect(h.getDecisionModel.mock.calls[0][0]).toMatchObject({
			frameId: INPUT.frameId,
		});
		expect(h.getLanguageModel.mock.calls[0][1]).toMatchObject({
			frameId: INPUT.frameId,
		});
		expect(h.getLanguageModel.mock.calls[0][1]).not.toHaveProperty(
			"workflowExecutionId",
		);
	});

	it("reads only the start of a long reply", async () => {
		decisionAnswer(0.02);

		await checkCompletionClaimActivity({
			...INPUT,
			reply: "x".repeat(10_000),
		});

		expect(h.decide.mock.calls[0][0].state.reply).toHaveLength(4_000);
	});

	it("uses the organization's bound wording when there is one", async () => {
		decisionAnswer(0.02);
		h.getBoundPromptForAgent.mockImplementation(
			async ({ agentName }: { agentName: string }) =>
				agentName === "advisor_completion_claim_judge"
					? {
							format: "HANDLEBARS",
							version: {
								version: 2,
								content: "Organization question.",
							},
						}
					: null,
		);

		await checkCompletionClaimActivity(INPUT);

		expect(
			h.decide.mock.calls[0][0].questions.claimsAction.instructions,
		).toBe("Organization question.");
	});
});

describe("without a decision model", () => {
	beforeEach(() => {
		h.getDecisionModel.mockRejectedValue(
			new Error("No typed decision model is available"),
		);
	});

	it("asks a SIMPLE-tier model for one word, with the request and reply fenced as data", async () => {
		languageAnswer("NO");

		const result = await checkCompletionClaimActivity(INPUT);

		expect(result).toMatchObject({
			unbackedClaim: false,
			judgedBy: "language",
		});
		expect(h.getLanguageModel).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			expect.objectContaining({ featureKey: "chat-agent" }),
		);
		const request = h.generateText.mock.calls[0][0];
		expect(request.instructions).toContain(
			COMPLETION_CLAIM_JUDGE_FALLBACK_BODY,
		);
		expect(request.prompt).toContain('<user-request trust="untrusted">');
		expect(request.prompt).toContain('<assistant-reply trust="untrusted">');
		expect(request.maxOutputTokens).toBeLessThanOrEqual(5);
	});

	it("reports no claim when the answer is neither yes nor no", async () => {
		languageAnswer("Maybe");

		const result = await checkCompletionClaimActivity(INPUT);

		expect(result.unbackedClaim).toBe(false);
	});

	it("lets the reply stand when no judge can answer", async () => {
		h.generateText.mockRejectedValue(new Error("provider down"));

		const result = await checkCompletionClaimActivity(INPUT);

		expect(result).toEqual({
			unbackedClaim: false,
			judgedBy: "none",
			usage: { inputTokens: 0, outputTokens: 0 },
		});
	});
});

describe("a stopped turn", () => {
	it("rethrows the stop instead of reporting no claim", async () => {
		const stop = ApplicationFailure.create({
			type: "TurnNotDispatchable",
			message: "Turn may not make another model request",
			nonRetryable: true,
			details: [{ reason: "cancelled" }],
		});
		h.decide.mockRejectedValue(stop);

		await expect(checkCompletionClaimActivity(INPUT)).rejects.toBe(stop);
	});
});
