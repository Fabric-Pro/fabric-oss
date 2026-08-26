import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI answer-recommendation pass (#7). Structured `generateObject` call over the
 * freshly minted questions; best-effort, never throws. These tests mock the model,
 * RAG, the bound-prompt lookup, and the metadata writer so they are deterministic
 * and make no network call.
 */

const mocks = vi.hoisted(() => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	retrieveProjectContexts: vi.fn(),
	formatContextsForPrompt: vi.fn(),
	setDecisionMetadata: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	getProjectFunctionTagClause: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
}));

vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: mocks.getProjectFunctionTagClause,
}));

vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: mocks.retrieveProjectContexts,
	formatContextsForPrompt: mocks.formatContextsForPrompt,
}));

vi.mock("@repo/database", () => ({
	setDecisionMetadata: mocks.setDecisionMetadata,
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn() },
}));

const { proposeQuestionAnswers, normalizeOptions, ANSWER_RECOMMENDATION_KEY } =
	await import("../propose-question-answers");

const tenantFilter = { organizationId: "org-1", userId: "user-1" } as const;

function feature() {
	return {
		id: "story-1",
		projectId: "project-1",
		title: "MFA",
		kind: "FEATURE",
		description: "## Overview\nAdd MFA.",
		acceptanceCriteria: null,
	};
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { providerKey: "stub" },
	});
	mocks.retrieveProjectContexts.mockResolvedValue([]);
	mocks.formatContextsForPrompt.mockReturnValue("ctx");
	mocks.setDecisionMetadata.mockResolvedValue(1);
	// Default: no bound prompt → code fallback instruction is used.
	mocks.getBoundPromptForAgent.mockResolvedValue(null);
	// Fizzy #1767 Stage 4: default to flag-OFF (no clause) so every
	// pre-existing test in this file keeps asserting the pre-Stage-4 system
	// prompt shape unchanged.
	mocks.getProjectFunctionTagClause.mockResolvedValue("");
});

describe("proposeQuestionAnswers", () => {
	it("stamps each question's root metadata with justified options", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				recommendations: [
					{
						id: 1,
						options: [
							{
								text: "Yes, mandatory.",
								justification: "Security baseline requires it.",
							},
							{
								text: "Optional per org",
								justification: "Lets teams opt in gradually.",
							},
						],
						confidence: "high",
					},
				],
			},
		});

		const out = await proposeQuestionAnswers({
			feature: feature(),
			questions: [{ rootId: "dec-1", question: "Is MFA mandatory?" }],
			tenantFilter,
		});

		expect(out).toEqual({ recommended: 1 });
		const call = mocks.setDecisionMetadata.mock.calls[0][0];
		expect(call.id).toBe("dec-1");
		expect(call.metadata[ANSWER_RECOMMENDATION_KEY]).toEqual({
			options: [
				{
					text: "Yes, mandatory.",
					justification: "Security baseline requires it.",
				},
				{
					text: "Optional per org",
					justification: "Lets teams opt in gradually.",
				},
			],
			confidence: "high",
		});
	});

	it("resolves the kind-scoped bound prompt as the instruction when present", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			version: { content: "ORG EDITED INSTRUCTION" },
		});
		mocks.generateObject.mockResolvedValue({
			object: { recommendations: [] },
		});

		await proposeQuestionAnswers({
			feature: feature(),
			questions: [{ rootId: "dec-1", question: "Is MFA mandatory?" }],
			tenantFilter,
		});

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "feature_answer_recommender",
				documentType: "ANSWER_RECOMMENDATIONS",
				storyKind: "FEATURE",
			}),
		);
		// FR-25 (#1747): the shared locked-attachment rule is appended to the
		// resolved instruction, so `system` carries BOTH the org instruction and
		// the rule (no longer an exact-equality match).
		expect(mocks.generateObject.mock.calls[0][0].system).toContain(
			"ORG EDITED INSTRUCTION",
		);
		expect(mocks.generateObject.mock.calls[0][0].system).toContain(
			"DEDICATED ATTACHMENTS",
		);
	});

	it("appends the locked-attachment rule to the system instruction", async () => {
		mocks.generateObject.mockResolvedValue({
			object: { recommendations: [] },
		});
		await proposeQuestionAnswers({
			feature: feature(),
			questions: [{ rootId: "dec-1", question: "Is MFA mandatory?" }],
			tenantFilter,
		});
		expect(mocks.generateObject.mock.calls[0][0].system).toContain(
			"DEDICATED ATTACHMENTS",
		);
	});

	it("uses the bug recommender agent for bug tickets", async () => {
		mocks.generateObject.mockResolvedValue({
			object: { recommendations: [] },
		});
		await proposeQuestionAnswers({
			feature: { ...feature(), kind: "BUG" },
			questions: [{ rootId: "dec-1", question: "Repro steps?" }],
			tenantFilter,
		});
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({ agentName: "bug_answer_recommender" }),
		);
	});

	it("skips a question whose options are all unjustified", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				recommendations: [
					{
						id: 1,
						options: [{ text: "Yes", justification: "" }],
						confidence: "low",
					},
				],
			},
		});

		const out = await proposeQuestionAnswers({
			feature: feature(),
			questions: [{ rootId: "dec-1", question: "Open-ended?" }],
			tenantFilter,
		});

		expect(out).toEqual({ recommended: 0 });
		expect(mocks.setDecisionMetadata).not.toHaveBeenCalled();
	});

	it("is best-effort: a model failure returns 0 and never throws", async () => {
		mocks.generateObject.mockRejectedValue(new Error("model down"));
		const out = await proposeQuestionAnswers({
			feature: feature(),
			questions: [{ rootId: "dec-1", question: "Is MFA mandatory?" }],
			tenantFilter,
		});
		expect(out).toEqual({ recommended: 0 });
		expect(mocks.setDecisionMetadata).not.toHaveBeenCalled();
	});

	it("no model call for empty input", async () => {
		const out = await proposeQuestionAnswers({
			feature: feature(),
			questions: [],
			tenantFilter,
		});
		expect(out).toEqual({ recommended: 0 });
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});
});

describe("proposeQuestionAnswers — function-tag role clause (Fizzy #1767 Stage 4)", () => {
	const ROLE_CLAUSE_SENTINEL =
		"PROJECT CONTRIBUTOR ROLES — sentinel-test-clause-propose-question-answers";

	beforeEach(() => {
		mocks.generateObject.mockResolvedValue({
			object: { recommendations: [] },
		});
	});

	it("flag ON: resolves the role clause with the feature's project/user and appends it to the system prompt", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await proposeQuestionAnswers({
			feature: feature(),
			questions: [{ rootId: "dec-1", question: "Is MFA mandatory?" }],
			tenantFilter,
		});

		expect(mocks.getProjectFunctionTagClause).toHaveBeenCalledWith({
			projectId: "project-1",
			requesterUserId: "user-1",
			surface: "propose-question-answers",
		});
		const system = mocks.generateObject.mock.calls[0][0].system;
		expect(system).toContain(ROLE_CLAUSE_SENTINEL);
	});

	it("flag OFF: system prompt is byte-for-byte identical to the no-clause assembly (no dangling separator)", async () => {
		// Capture the with-clause shape first...
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);
		await proposeQuestionAnswers({
			feature: feature(),
			questions: [{ rootId: "dec-1", question: "Is MFA mandatory?" }],
			tenantFilter,
		});
		const withClause = mocks.generateObject.mock.calls[0][0].system;

		// ...then the flag-OFF shape, from an otherwise-identical invocation.
		mocks.generateObject.mockClear();
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		await proposeQuestionAnswers({
			feature: feature(),
			questions: [{ rootId: "dec-1", question: "Is MFA mandatory?" }],
			tenantFilter,
		});
		const withoutClause = mocks.generateObject.mock.calls[0][0].system;

		expect(withoutClause).not.toContain(ROLE_CLAUSE_SENTINEL);
		expect(withClause).toBe(`${withoutClause}\n\n${ROLE_CLAUSE_SENTINEL}`);
	});
});

describe("normalizeOptions", () => {
	it("drops options without a justification (FR-2)", () => {
		expect(
			normalizeOptions([
				{ text: "A", justification: "because" },
				{ text: "B", justification: "" },
				{ text: "C" },
			]),
		).toEqual([{ text: "A", justification: "because" }]);
	});

	it("trims, dedupes by text (case-insensitive), caps at 4", () => {
		const many = [
			{ text: " A ", justification: "j" },
			{ text: "a", justification: "j2" },
			{ text: "B", justification: "j" },
			{ text: "C", justification: "j" },
			{ text: "D", justification: "j" },
			{ text: "E", justification: "j" },
		];
		const out = normalizeOptions(many);
		expect(out.map((o) => o.text)).toEqual(["A", "B", "C", "D"]);
	});

	it("returns [] for non-arrays", () => {
		expect(normalizeOptions(undefined)).toEqual([]);
		expect(normalizeOptions("nope")).toEqual([]);
	});
});
