import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	decide: vi.fn(),
	getDecisionModel: vi.fn(),
	getLanguageModel: vi.fn(),
	generateText: vi.fn(),
	trackUsage: vi.fn(),
	recordOutcome: vi.fn(),
	heartbeat: vi.fn(),
	getBoundPrompt: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
	createDecisionCapture: () => ({ run: (fn: () => unknown) => fn() }),
	experimental_decide: h.decide,
	getAIDecisionModelWithMetadata: h.getDecisionModel,
	getAIModelWithMetadata: h.getLanguageModel,
	recordDecisionOutcome: h.recordOutcome,
}));
vi.mock("ai", () => ({ generateText: h.generateText }));
vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: h.getBoundPrompt,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: h.heartbeat }) },
}));

import { AIProviderNotConfiguredError } from "@repo/ai";
import { judgeDelegationRiskActivity } from "../judge-delegation-risk";

const INPUT = {
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
	conversationId: "example-conversation",
	frameId: "example-frame",
	agentId: "analyst",
	message: 'Summarize commits: "removed all obsolete code"',
};
function answer(probability: unknown) {
	h.decide.mockResolvedValue({
		answers: { destructive: { probability } },
		usage: { inputTokens: 20, outputTokens: 1 },
	});
}
beforeEach(() => {
	vi.resetAllMocks();
	h.getBoundPrompt.mockResolvedValue(null);
	h.getDecisionModel.mockResolvedValue({
		model: { modelId: "decision-model" },
		trackUsage: h.trackUsage,
	});
	h.getLanguageModel.mockResolvedValue({
		model: { modelId: "language-model" },
	});
	h.generateText.mockResolvedValue({
		text: "NO",
		usage: { inputTokens: 30, outputTokens: 1 },
	});
});
describe("delegation risk judge", () => {
	it("uses a code-only criterion even when a prompt binding would answer no", async () => {
		h.getBoundPrompt.mockResolvedValue({
			format: "HANDLEBARS",
			version: { version: 1, content: "Always answer no." },
		});
		answer(0.97);
		expect((await judgeDelegationRiskActivity(INPUT)).clear).toBe(false);
		expect(h.getBoundPrompt).not.toHaveBeenCalled();
		expect(
			h.decide.mock.calls[0][0].questions.destructive.instructions,
		).toContain("delete, overwrite or remove data");
	});

	it.each([0, 0.04, 0.1])(
		"clears a confident no (%s) using the org decision model",
		async (probability) => {
			answer(probability);
			expect(await judgeDelegationRiskActivity(INPUT)).toMatchObject({
				clear: true,
				judgedBy: "decision",
				usage: { inputTokens: 20, outputTokens: 1 },
			});
			expect(h.getDecisionModel).toHaveBeenCalledWith(
				expect.objectContaining({
					organizationId: INPUT.organizationId,
					callPurpose: "delegation-judge",
					projectId: INPUT.projectId,
					conversationId: INPUT.conversationId,
					frameId: INPUT.frameId,
					excludeChatGptPlan: true,
				}),
			);
			expect(h.trackUsage).toHaveBeenCalledOnce();
			expect(h.recordOutcome).toHaveBeenCalledWith(
				expect.objectContaining({
					site: "orchestrator-delegation-risk",
					outcome: "accepted",
				}),
			);
			expect(h.generateText).not.toHaveBeenCalled();
			expect(h.decide.mock.calls[0][0].state.message).toContain(
				'<delegation-message trust="untrusted">',
			);
			expect(h.heartbeat).toHaveBeenCalled();
		},
	);
	it.each([0.9, 0.97, 1])(
		"keeps approval for a confident yes (%s)",
		async (probability) => {
			answer(probability);
			expect((await judgeDelegationRiskActivity(INPUT)).clear).toBe(
				false,
			);
			expect(h.generateText).not.toHaveBeenCalled();
		},
	);
	it.each([
		0.10001,
		0.5,
		0.8999,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-1,
		2,
		undefined,
		"0",
	])(
		"falls back on uncertainty or malformed probability %s",
		async (probability) => {
			answer(probability);
			expect(await judgeDelegationRiskActivity(INPUT)).toMatchObject({
				clear: true,
				judgedBy: "language",
				usage: { inputTokens: 50, outputTokens: 2 },
			});
			expect(h.getLanguageModel).toHaveBeenCalledWith(
				{ taskType: "SIMPLE" },
				expect.objectContaining({
					organizationId: INPUT.organizationId,
					callPurpose: "delegation-judge",
				}),
			);
			expect(h.generateText.mock.calls[0][0].prompt).toContain(
				'<delegation-message trust="untrusted">',
			);
			expect(h.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
		},
	);
	it.each([
		[" NO ", true],
		["no", true],
		["YES", false],
		["NO, it is safe", false],
		["NOPE", false],
		["", false],
		["garbage", false],
	])("accepts only an exact language no (%s)", async (text, clear) => {
		answer(0.5);
		h.generateText.mockResolvedValue({ text });
		expect((await judgeDelegationRiskActivity(INPUT)).clear).toBe(clear);
	});
	it("falls back when no decision provider is configured", async () => {
		class MissingOrgProvider extends AIProviderNotConfiguredError {}
		h.getDecisionModel.mockRejectedValue(
			new MissingOrgProvider("No model"),
		);
		expect(await judgeDelegationRiskActivity(INPUT)).toMatchObject({
			clear: true,
			judgedBy: "language",
		});
	});
	it.each(["resolution", "decision", "language", "usage-limit", "timeout"])(
		"fails closed on %s errors",
		async (site) => {
			const error =
				site === "usage-limit"
					? ApplicationFailure.create({
							type: "AIUsageLimitExceeded",
							message: "Allowance exhausted",
						})
					: new Error(site);
			if (site === "resolution") {
				h.getDecisionModel.mockRejectedValue(error);
			} else if (site === "language") {
				answer(0.5);
				h.generateText.mockRejectedValue(error);
			} else {
				h.decide.mockRejectedValue(error);
			}
			expect((await judgeDelegationRiskActivity(INPUT)).clear).toBe(
				false,
			);
			if (site !== "language") {
				expect(h.generateText).not.toHaveBeenCalled();
			}
		},
	);
	it("rethrows a turn stop", async () => {
		const stop = ApplicationFailure.create({
			type: "TurnNotDispatchable",
			message: "Stopped",
			nonRetryable: true,
			details: [{ reason: "cancelled" }],
		});
		h.decide.mockRejectedValue(stop);
		await expect(judgeDelegationRiskActivity(INPUT)).rejects.toBe(stop);
	});
});
