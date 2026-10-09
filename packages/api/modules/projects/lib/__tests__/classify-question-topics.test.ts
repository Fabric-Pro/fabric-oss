import { Experimental_DecisionRefusalError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	capturedDecisionOutcomes,
	decideWithFallbackRefusal,
	resetCapturedDecisionOutcomes,
} from "./support/decision-outcomes";

const mocks = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	generateObject: vi.fn(),
	getAIDecisionModelWithMetadata: vi.fn(),
	experimental_decide: vi.fn(),
	trackUsage: vi.fn(),
}));

const { AiUsageLimitExceededError } = vi.hoisted(() => {
	class AiUsageLimitExceededError extends Error {}
	return { AiUsageLimitExceededError };
});

vi.mock("@repo/ai", async () => ({
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	generateObject: mocks.generateObject,
	getAIDecisionModelWithMetadata: mocks.getAIDecisionModelWithMetadata,
	experimental_decide: mocks.experimental_decide,
	recordDecisionOutcome: await (
		await import("./support/decision-outcomes")
	).realRecordDecisionOutcome(),
	createDecisionCapture: await (
		await import("./support/decision-outcomes")
	).realCreateDecisionCapture(),
}));

// The real telemetry helper runs against this stand-in, so tests assert the
// outcome, model and confidence samples that would reach the metrics.
vi.mock("@repo/observability/llm", async () =>
	(await import("./support/decision-outcomes")).observabilityLlmMock(),
);

vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

vi.mock("@repo/payments/lib/ai-usage-limit-error", () => ({
	AiUsageLimitExceededError,
}));

const { classifyQuestionTopics } = await import("../classify-question-topics");

const tenantFilter = { organizationId: "org-1", userId: "user-1" } as const;

/** Pinned `buildPrompt(["Which toolkit?", "Feature flag or big bang?"])` output. */
const MASTER_PROMPT_TWO =
	'Classify each product-management question below into exactly ONE of these topics:\n- Scope & Requirements\n- Tooling & Tech\n- Data & Storage\n- UX & Design\n- Rollout & Migration\n- Integrations & Sources\n- Testing & QA\n- Other\n\nRules:\n- Pick the single best-fit topic. Use "Other" only when none clearly applies.\n- Questions about which library/framework/toolkit to use → "Tooling & Tech".\n- Questions about storing/retrieving/modelling data → "Data & Storage".\n- Questions about layout, interaction, or visual design → "UX & Design".\n- Questions about release strategy, feature flags, or migrating existing data → "Rollout & Migration".\n- Questions about connecting to external sources/services → "Integrations & Sources".\n- Questions about test coverage, acceptance criteria, or QA → "Testing & QA".\n- Questions about what is in/out of scope or what a requirement means → "Scope & Requirements".\n- Return one assignment per question, referencing its number.\n\nQUESTIONS:\n1. Which toolkit?\n2. Feature flag or big bang?';

/** Pinned `buildPrompt(["Where does the panel go?"])` output — numbering restarts at 1. */
const MASTER_PROMPT_SINGLE_PANEL =
	'Classify each product-management question below into exactly ONE of these topics:\n- Scope & Requirements\n- Tooling & Tech\n- Data & Storage\n- UX & Design\n- Rollout & Migration\n- Integrations & Sources\n- Testing & QA\n- Other\n\nRules:\n- Pick the single best-fit topic. Use "Other" only when none clearly applies.\n- Questions about which library/framework/toolkit to use → "Tooling & Tech".\n- Questions about storing/retrieving/modelling data → "Data & Storage".\n- Questions about layout, interaction, or visual design → "UX & Design".\n- Questions about release strategy, feature flags, or migrating existing data → "Rollout & Migration".\n- Questions about connecting to external sources/services → "Integrations & Sources".\n- Questions about test coverage, acceptance criteria, or QA → "Testing & QA".\n- Questions about what is in/out of scope or what a requirement means → "Scope & Requirements".\n- Return one assignment per question, referencing its number.\n\nQUESTIONS:\n1. Where does the panel go?';

/** Resolver resolves an available decision model backed by `mocks.trackUsage`. */
function enableDecisionModel() {
	mocks.getAIDecisionModelWithMetadata.mockResolvedValue({
		model: {},
		trackUsage: mocks.trackUsage,
	});
}

const MISSING = Symbol("missing");

/**
 * Builds an `experimental_decide` result. `entries` maps a question index to
 * the answer body merged onto `{ type: "choice" }` (or to {@link MISSING} to
 * omit that key entirely, simulating a missing answer).
 */
function answers(
	entries: Record<number, Record<string, unknown> | typeof MISSING>,
): { answers: Record<string, unknown> } {
	const out: Record<string, unknown> = {};
	for (const [index, entry] of Object.entries(entries)) {
		if (entry === MISSING) {
			continue;
		}
		out[`question_${index}`] = { type: "choice", ...entry };
	}
	return { answers: out };
}

/** A well-formed confident `choice` answer body for {@link answers}. */
function choice(topic: string, probability: number) {
	return { choice: topic, probabilities: { [topic]: probability } };
}

beforeEach(() => {
	mocks.getAIModelWithMetadata.mockReset();
	mocks.generateObject.mockReset();
	mocks.getAIDecisionModelWithMetadata.mockReset();
	mocks.experimental_decide.mockReset();
	mocks.trackUsage.mockReset();
	mocks.getAIModelWithMetadata.mockResolvedValue({ model: {} });
	// Default: no decision model configured, so existing tests exercise only
	// the language path, exactly as before this fast path existed.
	mocks.getAIDecisionModelWithMetadata.mockRejectedValue(
		new Error("not configured"),
	);
});

describe("classifyQuestionTopics", () => {
	it("returns [] and makes no model call for empty input", async () => {
		const out = await classifyQuestionTopics({
			questions: [],
			tenantFilter,
		});
		expect(out).toEqual([]);
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("maps assignments back to the questions by 1-based id", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				assignments: [
					{ id: 1, topic: "Tooling & Tech" },
					{ id: 2, topic: "Rollout & Migration" },
				],
			},
		});
		const out = await classifyQuestionTopics({
			questions: ["Which toolkit?", "Feature flag or big bang?"],
			tenantFilter,
		});
		expect(out).toEqual(["Tooling & Tech", "Rollout & Migration"]);
	});

	it("falls back to 'Other' for any question the model didn't label", async () => {
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [{ id: 2, topic: "UX & Design" }] },
		});
		const out = await classifyQuestionTopics({
			questions: ["Unlabelled?", "Where does the panel go?"],
			tenantFilter,
		});
		expect(out).toEqual(["Other", "UX & Design"]);
	});

	it("falls back to all 'Other' when the model call throws", async () => {
		mocks.generateObject.mockRejectedValue(new Error("model down"));
		const out = await classifyQuestionTopics({
			questions: ["a?", "b?"],
			tenantFilter,
		});
		expect(out).toEqual(["Other", "Other"]);
	});
});

describe("typed decision fast path", () => {
	it("no decision model: the language prompt is exact and the resolver args are exact", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				assignments: [
					{ id: 1, topic: "Tooling & Tech" },
					{ id: 2, topic: "Rollout & Migration" },
				],
			},
		});
		const out = await classifyQuestionTopics({
			questions: ["Which toolkit?", "Feature flag or big bang?"],
			tenantFilter,
		});
		expect(out).toEqual(["Tooling & Tech", "Rollout & Migration"]);
		expect(mocks.getAIDecisionModelWithMetadata).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			featureKey: "maturation",
		});
		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: MASTER_PROMPT_TWO }),
		);
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			{
				userId: "user-1",
				organizationId: "org-1",
				featureKey: "maturation",
			},
		);
	});

	it("getAIModelWithMetadata rejects (decision resolver rejecting as default): all 'Other' and generateObject is not called", async () => {
		mocks.getAIModelWithMetadata.mockRejectedValue(
			new Error("no language model"),
		);
		const out = await classifyQuestionTopics({
			questions: ["Which toolkit?", "Feature flag or big bang?"],
			tenantFilter,
		});
		expect(out).toEqual(["Other", "Other"]);
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("organizationId: null tenant filter resolves the decision model with organizationId: undefined", async () => {
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [{ id: 1, topic: "Other" }] },
		});
		await classifyQuestionTopics({
			questions: ["a?"],
			tenantFilter: { organizationId: null, userId: "user-1" },
		});
		expect(mocks.getAIDecisionModelWithMetadata).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: undefined,
			featureKey: "maturation",
		});
	});

	it("all questions confident: topics come from the decision answers, no generateObject, trackUsage once, no getAIModelWithMetadata", async () => {
		enableDecisionModel();
		mocks.experimental_decide.mockResolvedValue(
			answers({
				0: choice("Tooling & Tech", 0.95),
				1: choice("Other", 0.9),
			}),
		);
		const out = await classifyQuestionTopics({
			questions: ["Which toolkit?", "Feature flag or big bang?"],
			tenantFilter,
		});
		expect(out).toEqual(["Tooling & Tech", "Other"]);
		expect(mocks.generateObject).not.toHaveBeenCalled();
		expect(mocks.trackUsage).toHaveBeenCalledTimes(1);
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("partial: index 1 uncertain sends only that question (numbered 1.) to the language model, and its assignment lands back at index 1", async () => {
		enableDecisionModel();
		mocks.experimental_decide.mockResolvedValue(
			answers({
				0: choice("Tooling & Tech", 0.95),
				// index 1 left uncertain (missing answer)
				2: choice("Testing & QA", 0.92),
			}),
		);
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [{ id: 1, topic: "UX & Design" }] },
		});
		const out = await classifyQuestionTopics({
			questions: [
				"Which toolkit?",
				"Where does the panel go?",
				"Do we need e2e coverage?",
			],
			tenantFilter,
		});
		expect(out).toEqual(["Tooling & Tech", "UX & Design", "Testing & QA"]);
		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: MASTER_PROMPT_SINGLE_PANEL }),
		);
	});

	it("language path throws after a partial decision: decided labels are kept, the leftover stays 'Other'", async () => {
		enableDecisionModel();
		mocks.experimental_decide.mockResolvedValue(
			answers({ 0: choice("Tooling & Tech", 0.95) }),
		);
		mocks.generateObject.mockRejectedValue(new Error("model down"));
		const out = await classifyQuestionTopics({
			questions: ["Which toolkit?", "Where does the panel go?"],
			tenantFilter,
		});
		expect(out).toEqual(["Tooling & Tech", "Other"]);
	});

	it("probability exactly 0.9 is accepted; 0.8999 is leftover", async () => {
		enableDecisionModel();
		mocks.experimental_decide.mockResolvedValue(
			answers({
				0: choice("Tooling & Tech", 0.9),
				1: choice("Testing & QA", 0.8999),
			}),
		);
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [{ id: 1, topic: "Testing & QA" }] },
		});
		const out = await classifyQuestionTopics({
			questions: ["a?", "b?"],
			tenantFilter,
		});
		expect(out).toEqual(["Tooling & Tech", "Testing & QA"]);
		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
	});

	it("'Other' at 0.95 from the decision model is accepted without a language call", async () => {
		enableDecisionModel();
		mocks.experimental_decide.mockResolvedValue(
			answers({ 0: choice("Other", 0.95) }),
		);
		const out = await classifyQuestionTopics({
			questions: ["Ambiguous?"],
			tenantFilter,
		});
		expect(out).toEqual(["Other"]);
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it.each([
		["missing answer", MISSING],
		["type: boolean", { type: "boolean", probability: 0.95 }],
		[
			"choice not in the taxonomy",
			{ choice: "Nonexistent", probabilities: { Nonexistent: 0.95 } },
		],
		["missing probabilities", { choice: "Other" }],
		[
			"probabilities[choice] not a number",
			{ choice: "Other", probabilities: { Other: "high" } },
		],
		[
			"NaN probability",
			{ choice: "Other", probabilities: { Other: Number.NaN } },
		],
		[
			"probability greater than 1",
			{ choice: "Other", probabilities: { Other: 1.2 } },
		],
	] as const)(
		"malformed decision answer (%s) is treated as leftover",
		async (_label, malformed) => {
			enableDecisionModel();
			mocks.experimental_decide.mockResolvedValue(
				answers({
					0: malformed as Record<string, unknown> | typeof MISSING,
				}),
			);
			mocks.generateObject.mockResolvedValue({
				object: { assignments: [{ id: 1, topic: "Data & Storage" }] },
			});
			const out = await classifyQuestionTopics({
				questions: ["q?"],
				tenantFilter,
			});
			expect(out).toEqual(["Data & Storage"]);
			expect(mocks.generateObject).toHaveBeenCalledTimes(1);
		},
	);

	it("all uncertain: trackUsage is still called once, then the language call runs over all questions with the master prompt", async () => {
		enableDecisionModel();
		mocks.experimental_decide.mockResolvedValue(
			answers({
				0: choice("Tooling & Tech", 0.5),
				1: choice("Other", 0.4),
			}),
		);
		mocks.generateObject.mockResolvedValue({
			object: {
				assignments: [
					{ id: 1, topic: "Tooling & Tech" },
					{ id: 2, topic: "Rollout & Migration" },
				],
			},
		});
		const out = await classifyQuestionTopics({
			questions: ["Which toolkit?", "Feature flag or big bang?"],
			tenantFilter,
		});
		expect(mocks.trackUsage).toHaveBeenCalledTimes(1);
		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: MASTER_PROMPT_TWO }),
		);
		expect(out).toEqual(["Tooling & Tech", "Rollout & Migration"]);
	});

	it("evaluate rejects with a generic error: trackUsage is not called, and the language path runs over all questions", async () => {
		enableDecisionModel();
		mocks.experimental_decide.mockRejectedValue(new Error("evaluate down"));
		mocks.generateObject.mockResolvedValue({
			object: {
				assignments: [
					{ id: 1, topic: "Tooling & Tech" },
					{ id: 2, topic: "Rollout & Migration" },
				],
			},
		});
		const out = await classifyQuestionTopics({
			questions: ["Which toolkit?", "Feature flag or big bang?"],
			tenantFilter,
		});
		expect(mocks.trackUsage).not.toHaveBeenCalled();
		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: MASTER_PROMPT_TWO }),
		);
		expect(out).toEqual(["Tooling & Tech", "Rollout & Migration"]);
	});

	it("a decision refusal is no decision: no topic is taken from it, and the language path labels every question", async () => {
		// Drive the REAL SDK `experimental_decide` against a model that refuses
		// every question, so the site sees exactly what the SDK produces for a
		// refusal (a thrown Experimental_DecisionRefusalError).
		const ai = await vi.importActual<typeof import("ai")>("ai");
		const refusingModel = {
			specificationVersion: "v4" as const,
			provider: "example-decider",
			modelId: "example/refusing-decider",
			supportedQuestionTypes: ["choice" as const],
			doDecide: async ({
				questions,
			}: {
				questions: Record<string, unknown>;
			}) => ({
				answers: Object.fromEntries(
					Object.keys(questions).map((id) => [
						id,
						{ type: "refusal" as const },
					]),
				),
				warnings: [],
			}),
		};
		enableDecisionModel();
		mocks.experimental_decide.mockImplementation(
			(args: Parameters<typeof ai.experimental_decide>[0]) =>
				ai.experimental_decide({
					...args,
					model: refusingModel as unknown as Parameters<
						typeof ai.experimental_decide
					>[0]["model"],
				}),
		);
		mocks.generateObject.mockResolvedValue({
			object: {
				assignments: [
					{ id: 1, topic: "Tooling & Tech" },
					{ id: 2, topic: "Rollout & Migration" },
				],
			},
		});

		const out = await classifyQuestionTopics({
			questions: ["Which toolkit?", "Feature flag or big bang?"],
			tenantFilter,
		});

		await expect(
			mocks.experimental_decide.mock.results[0]?.value,
		).rejects.toSatisfy((error: unknown) =>
			ai.Experimental_DecisionRefusalError.isInstance(error),
		);
		expect(mocks.trackUsage).not.toHaveBeenCalled();
		// Both questions went to the language model: nothing was settled from
		// the refusal, not even as "Other".
		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: MASTER_PROMPT_TWO }),
		);
		expect(out).toEqual(["Tooling & Tech", "Rollout & Migration"]);
	});

	it("usage limit at resolution: all 'Other', experimental_decide and getAIModelWithMetadata are both not called", async () => {
		mocks.getAIDecisionModelWithMetadata.mockRejectedValue(
			new AiUsageLimitExceededError("limit"),
		);
		const out = await classifyQuestionTopics({
			questions: ["a?", "b?"],
			tenantFilter,
		});
		expect(out).toEqual(["Other", "Other"]);
		expect(mocks.experimental_decide).not.toHaveBeenCalled();
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("usage limit at evaluate: all 'Other', trackUsage is not called, getAIModelWithMetadata is not called", async () => {
		enableDecisionModel();
		mocks.experimental_decide.mockRejectedValue(
			new AiUsageLimitExceededError("limit"),
		);
		const out = await classifyQuestionTopics({
			questions: ["a?", "b?"],
			tenantFilter,
		});
		expect(out).toEqual(["Other", "Other"]);
		expect(mocks.trackUsage).not.toHaveBeenCalled();
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("empty input: the decision resolver is not called", async () => {
		const out = await classifyQuestionTopics({
			questions: [],
			tenantFilter,
		});
		expect(out).toEqual([]);
		expect(mocks.getAIDecisionModelWithMetadata).not.toHaveBeenCalled();
	});

	it("experimental_decide request: questions/criteria/state/maxRetries/abortSignal are exact", async () => {
		enableDecisionModel();
		mocks.experimental_decide.mockResolvedValue(answers({}));
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [] },
		});
		const questions = [
			"Which toolkit?",
			"Where does the panel go?",
			"Do we need e2e coverage?",
		];
		await classifyQuestionTopics({ questions, tenantFilter });

		expect(mocks.experimental_decide).toHaveBeenCalledTimes(1);
		const call = mocks.experimental_decide.mock.calls[0][0];

		expect(Object.keys(call.questions)).toEqual([
			"question_0",
			"question_1",
			"question_2",
		]);
		const topics = [
			"Scope & Requirements",
			"Tooling & Tech",
			"Data & Storage",
			"UX & Design",
			"Rollout & Migration",
			"Integrations & Sources",
			"Testing & QA",
			"Other",
		];
		for (const key of Object.keys(call.questions)) {
			expect(call.questions[key].type).toBe("choice");
			expect(Object.keys(call.questions[key].criteria)).toEqual(topics);
		}

		expect(call.state.questions).toEqual([
			{ key: "question_0", text: questions[0] },
			{ key: "question_1", text: questions[1] },
			{ key: "question_2", text: questions[2] },
		]);
		expect(call.maxRetries).toBe(1);
		expect(call.abortSignal).toBeInstanceOf(AbortSignal);
	});

	it("trackUsage runs before the answers are inspected", async () => {
		const order: string[] = [];
		mocks.getAIDecisionModelWithMetadata.mockResolvedValue({
			model: {},
			trackUsage: () => {
				order.push("trackUsage");
			},
		});
		const evalResult = {
			get answers() {
				order.push("answers");
				return {};
			},
		};
		mocks.experimental_decide.mockResolvedValue(evalResult);
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [{ id: 1, topic: "Other" }] },
		});

		await classifyQuestionTopics({ questions: ["a?"], tenantFilter });

		expect(order[0]).toBe("trackUsage");
		expect(order).toContain("answers");
		expect(order.indexOf("trackUsage")).toBeLessThan(
			order.indexOf("answers"),
		);
	});

	it("partial with non-contiguous leftovers: uncertain indices 0 and 2 go to the language model, renumbered 1. and 2., while decided indices 1 and 3 keep their decision labels", async () => {
		enableDecisionModel();
		mocks.experimental_decide.mockResolvedValue(
			answers({
				1: choice("Rollout & Migration", 0.95),
				3: choice("UX & Design", 0.93),
			}),
		);
		mocks.generateObject.mockResolvedValue({
			object: {
				assignments: [
					{ id: 1, topic: "Data & Storage" },
					{ id: 2, topic: "Testing & QA" },
				],
			},
		});
		const questions = [
			"How do we store the export history?",
			"Do we roll this out behind a flag?",
			"What e2e coverage do we need?",
			"Where should the empty state render?",
		];
		const out = await classifyQuestionTopics({ questions, tenantFilter });

		expect(out).toEqual([
			"Data & Storage",
			"Rollout & Migration",
			"Testing & QA",
			"UX & Design",
		]);

		const questionsMarker = "QUESTIONS:\n";
		const expectedPrompt =
			MASTER_PROMPT_TWO.slice(
				0,
				MASTER_PROMPT_TWO.indexOf(questionsMarker) +
					questionsMarker.length,
			) +
			"1. How do we store the export history?\n2. What e2e coverage do we need?";
		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: expectedPrompt }),
		);
	});
});

describe("decision telemetry", () => {
	const SITE = "question-topics";

	beforeEach(() => {
		resetCapturedDecisionOutcomes();
		mocks.getAIDecisionModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: {
				provider: "VERCEL_GATEWAY",
				modelString: "openai/example-decider",
				canonicalName: "example-decider",
			},
			trackUsage: mocks.trackUsage,
		});
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [{ id: 1, topic: "UX & Design" }] },
		});
	});

	it("records one outcome and confidence sample per question", async () => {
		mocks.experimental_decide.mockResolvedValue({
			...answers({
				0: choice("Tooling & Tech", 0.97),
				1: choice("UX & Design", 0.55),
				2: { choice: "Data & Storage" },
			}),
			response: { modelId: "typesafe-ai/jev" },
		});

		await classifyQuestionTopics({
			questions: ["a?", "b?", "c?"],
			tenantFilter,
		});

		expect(capturedDecisionOutcomes).toEqual([
			{
				site: SITE,
				outcome: "accepted",
				model: "typesafe-ai-jev",
				confidences: [0.97],
			},
			{
				site: SITE,
				outcome: "below_threshold",
				model: "typesafe-ai-jev",
				confidences: [0.55],
			},
			{
				site: SITE,
				outcome: "malformed",
				model: "typesafe-ai-jev",
				confidences: [],
			},
		]);
		// Only the two unsettled questions reach the language classifier.
		expect(mocks.generateObject).toHaveBeenCalledOnce();
	});

	it("records a failed or refused call once per question, and the language classifier still runs", async () => {
		mocks.experimental_decide.mockRejectedValueOnce(
			new Error("gateway timeout"),
		);
		await classifyQuestionTopics({ questions: ["a?", "b?"], tenantFilter });
		mocks.experimental_decide.mockRejectedValueOnce(
			new Experimental_DecisionRefusalError({
				questionIds: ["question_0"],
				provider: "example-provider",
				modelId: "example/decider",
			}),
		);
		await classifyQuestionTopics({ questions: ["a?", "b?"], tenantFilter });

		expect(mocks.generateObject).toHaveBeenCalledTimes(2);
		expect(
			capturedDecisionOutcomes.map(({ outcome, model, count }) => [
				outcome,
				model,
				count,
			]),
		).toEqual([
			["failed", "example-decider", 2],
			["refused", "example-decider", 2],
		]);
	});

	it("records limit_exceeded, with no language fallback, at the decision call and at resolution", async () => {
		mocks.experimental_decide.mockRejectedValueOnce(
			new AiUsageLimitExceededError(),
		);
		const decisionLimited = await classifyQuestionTopics({
			questions: ["a?", "b?"],
			tenantFilter,
		});
		mocks.getAIDecisionModelWithMetadata.mockRejectedValueOnce(
			new AiUsageLimitExceededError(),
		);
		const resolutionLimited = await classifyQuestionTopics({
			questions: ["a?", "b?", "c?"],
			tenantFilter,
		});

		expect(decisionLimited).toEqual(["Other", "Other"]);
		expect(resolutionLimited).toEqual(["Other", "Other", "Other"]);
		expect(mocks.generateObject).not.toHaveBeenCalled();
		expect(
			capturedDecisionOutcomes.map(({ outcome, model, count }) => [
				outcome,
				model,
				count,
			]),
		).toEqual([
			["limit_exceeded", "example-decider", 2],
			["limit_exceeded", "none", 3],
		]);
	});

	it("records unavailable per question when no decision model resolves", async () => {
		mocks.getAIDecisionModelWithMetadata.mockRejectedValue(
			new Error("not configured"),
		);

		await classifyQuestionTopics({ questions: ["a?", "b?"], tenantFilter });

		expect(capturedDecisionOutcomes).toEqual([
			{
				site: SITE,
				outcome: "unavailable",
				model: "none",
				confidences: [],
				count: 2,
			},
		]);
	});

	it("records nothing for empty input, which makes no decision call", async () => {
		await classifyQuestionTopics({ questions: [], tenantFilter });

		expect(capturedDecisionOutcomes).toEqual([]);
	});

	it("labels a refusal by the gateway fallback model with that model, once per question", async () => {
		mocks.experimental_decide.mockImplementationOnce(
			decideWithFallbackRefusal,
		);

		await classifyQuestionTopics({ questions: ["a?", "b?"], tenantFilter });

		expect(
			capturedDecisionOutcomes.map(({ outcome, model, count }) => [
				outcome,
				model,
				count,
			]),
		).toEqual([["refused", "typesafe-ai-jev", 2]]);
	});
});
