import {
	effectivePlanningAnalysis,
	renderAnalysisProse,
} from "@repo/utils/publishing-analysis-prose";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Short Post / Tweet LLM activity (Fizzy #1853, Phase 2B-2).
 *
 * No generate-activity harness existed for this file before the contributor
 * override (Fizzy #2068 follow-up, Task 5). Scoped deliberately rather than
 * exhaustively: it pins the same tenancy/actor-revalidation shape its Planning
 * & Analysis and Case Study siblings already have tests for, plus the happy
 * path and the contributor-override behaviour this task adds. It does NOT
 * re-derive full coverage of promptSource states, the output-token budget or
 * the restriction/decision split — those are exercised by
 * `build-short-post-prompt.test.ts` at the pure-function layer and by the
 * sibling activities' own harnesses, and duplicating them here would test the
 * shared plumbing a sixth time rather than this file's own logic.
 */

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const generateObject = vi.fn();
const getAIModelWithMetadata = vi.fn();
vi.mock("@repo/ai", () => ({
	generateObject: (...a: unknown[]) => generateObject(...a),
	getAIModelWithMetadata: (...a: unknown[]) => getAIModelWithMetadata(...a),
}));

const computeMaxOutputTokenBudget = vi.fn();
vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeMaxOutputTokenBudget: (...a: unknown[]) =>
		computeMaxOutputTokenBudget(...a),
}));

const getProjectFunctionTagClause = vi.fn();
vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: (...a: unknown[]) =>
		getProjectFunctionTagClause(...a),
}));

const topicFindFirst = vi.fn();
const analysisFindFirst = vi.fn();
const userFindMany = vi.fn();
const checkPublishingGenerationActor = vi.fn();
const getBoundPromptForAgent = vi.fn();
const listTopicDecisions = vi.fn();
const getEffectivePlanningAnalysis = vi.fn();
const completeTopicDraft = vi.fn();
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		// The REAL implementation, not a hand-rolled stand-in — a second copy
		// here would encode this file's guess of the override semantics
		// instead of measuring them, and the empty-override case is exactly
		// where a guess goes wrong.
		effectiveContributorUserIds: actual.effectiveContributorUserIds,
		logDraftRefusal: vi.fn(),
		db: {
			publishingTopic: {
				findFirst: (...a: unknown[]) => topicFindFirst(...a),
			},
			publishingTopicPlanningAnalysis: {
				findFirst: (...a: unknown[]) => analysisFindFirst(...a),
			},
			user: { findMany: (...a: unknown[]) => userFindMany(...a) },
		},
		checkPublishingGenerationActor: (...a: unknown[]) =>
			checkPublishingGenerationActor(...a),
		getBoundPromptForAgent: (...a: unknown[]) =>
			getBoundPromptForAgent(...a),
		getEffectivePlanningAnalysis: (...a: unknown[]) =>
			getEffectivePlanningAnalysis(...a),
		listTopicDecisions: (...a: unknown[]) => listTopicDecisions(...a),
		completeTopicDraft: (...a: unknown[]) => completeTopicDraft(...a),
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const collectPlanningContext = vi.fn();
vi.mock("../../publishing-planning/collect-planning-context", () => ({
	collectPlanningContext: (...a: unknown[]) => collectPlanningContext(...a),
}));

import { generateShortPostActivity } from "../generate-short-post";

const trackUsage = vi.fn();

const TOPIC = {
	id: "topic-1",
	title: "Faster incremental builds",
	pitch: "Builds now reuse a warm cache.",
	angle: "delivery velocity",
	subject: "build caching",
	relevantFunctionTags: ["BACKEND"],
	postTypeRecommendations: [],
	contributorUserIds: ["user-2"],
	contributorsOverridden: false,
	userContributorUserIds: [],
	provenance: {},
};

const MODEL_OUTPUT = {
	options: [
		{
			label: "Direct",
			text: "We cut build cold-starts with a warm cache.",
			estimatedCharacters: 46,
		},
		{
			label: "Question",
			text: "What if your builds never started cold again?",
			estimatedCharacters: 47,
		},
		{
			label: "Data-led",
			text: "Warm caches cut our build start time in half.",
			estimatedCharacters: 47,
		},
	],
	hashtags: [],
	inputsNeeded: [],
	safetyNote: null,
};

const CONTEXT_RESULT = {
	context: {
		stories: [],
		documents: [],
		transcripts: [],
		repoPrs: [],
	},
	sourceRefs: {
		stories: [],
		documents: [],
		transcripts: [],
		repoPrs: [],
		prBodiesFetched: 0,
		activeRepoCount: null,
		unresolved: { storyIds: [], docIds: [], transcriptIds: [] },
		failures: {},
	},
};

const NO_ANALYSIS = {
	effective: null,
	aiVersion: null,
	revisionVersion: null,
	sourceAnalysisVersion: null,
	author: null,
	revisionCreatedAt: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	topicFindFirst.mockResolvedValue(TOPIC);
	analysisFindFirst.mockResolvedValue(null);
	userFindMany.mockResolvedValue([{ id: "user-2", name: "A Contributor" }]);
	checkPublishingGenerationActor.mockResolvedValue({ ok: true });
	getBoundPromptForAgent.mockResolvedValue(null);
	listTopicDecisions.mockResolvedValue([]);
	getEffectivePlanningAnalysis.mockResolvedValue(NO_ANALYSIS);
	collectPlanningContext.mockResolvedValue(CONTEXT_RESULT);
	getProjectFunctionTagClause.mockResolvedValue("");
	computeMaxOutputTokenBudget.mockReturnValue(8192);
	getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { modelString: "test-model", provider: "test" },
		trackUsage,
	});
	generateObject.mockResolvedValue({
		object: MODEL_OUTPUT,
		usage: { totalTokens: 100 },
	});
	completeTopicDraft.mockResolvedValue({ persisted: true });
});

const run = (overrides: Record<string, unknown> = {}) =>
	generateShortPostActivity({
		draftId: "draft-1",
		topicId: "topic-1",
		projectId: "proj-1",
		organizationId: "org-1",
		actorUserId: "user-1",
		guidance: null,
		...overrides,
	});

describe("generateShortPostActivity — tenancy and actor revalidation", () => {
	it("re-scopes the topic read by projectId", async () => {
		await run();

		expect(topicFindFirst.mock.calls[0]?.[0]?.where).toEqual({
			id: "topic-1",
			projectId: "proj-1",
		});
	});

	it("fails closed when the topic does not resolve inside the project", async () => {
		topicFindFirst.mockResolvedValue(null);

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_TENANT_MISMATCH",
			nonRetryable: true,
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("re-checks the actor's PROJECT authorization before resolving a model", async () => {
		await run();

		expect(checkPublishingGenerationActor).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			actorUserId: "user-1",
		});
	});

	it("never reaches the model factory when the actor is no longer authorized", async () => {
		checkPublishingGenerationActor.mockResolvedValue({
			ok: false,
			reason: "NOT_AUTHORIZED",
			currentOrganizationId: "org-1",
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_ACTOR_INVALID",
			nonRetryable: true,
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(generateObject).not.toHaveBeenCalled();
	});
});

describe("generateShortPostActivity — contributor override", () => {
	// `effectiveContributorUserIds` is the ONLY thing that may decide who the
	// prompt calls a contributor — never `topic.contributorUserIds` directly.
	it("builds the prompt from the override, not the AI list", async () => {
		topicFindFirst.mockResolvedValue({
			...TOPIC,
			contributorUserIds: ["ai-user"],
			contributorsOverridden: true,
			userContributorUserIds: ["chosen-user"],
		});
		userFindMany.mockResolvedValue([
			{ id: "chosen-user", name: "Chosen Contributor" },
		]);

		await run();

		expect(userFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["chosen-user"] } },
			}),
		);
		expect(generateObject.mock.calls[0]?.[0]?.prompt).toContain(
			"Chosen Contributor",
		);
	});

	it("yields no contributor names when the override is deliberately empty", async () => {
		// `contributorsOverridden: true` with an empty `userContributorUserIds`
		// is "nobody", not "fall back to the AI list" — the case a hand-rolled
		// mock of `effectiveContributorUserIds` would be most likely to get
		// wrong.
		topicFindFirst.mockResolvedValue({
			...TOPIC,
			contributorUserIds: ["ai-user"],
			contributorsOverridden: true,
			userContributorUserIds: [],
		});

		await run();

		// `resolveContributorNames` short-circuits on an empty list, so the
		// lookup never runs at all.
		expect(userFindMany).not.toHaveBeenCalled();
		expect(generateObject.mock.calls[0]?.[0]?.prompt).not.toContain(
			"People associated with the work behind this topic",
		);
	});
});

describe("generateShortPostActivity — the effective analysis reaches the prompt", () => {
	// Fizzy #1851. The activity must resolve the topic's analysis through
	// `getEffectivePlanningAnalysis` — the ONE reader that knows about the
	// author's revision — and not off the AI row it used to query inline.
	//
	// This lives at the ACTIVITY level and not on the prompt builder on
	// purpose: a builder test receives its input already resolved, so it passes
	// identically whether this activity calls the resolver or still queries the
	// table. It cannot observe the bug it is named after.
	const AI = {
		topicAngle: "AI ANGLE: the model's own framing.",
		contentTypes: { recommended: [{ type: "Tweet" }] },
	};

	it("feeds the user's edited prose to the prompt, not the AI's original", async () => {
		// BOTH sources are stocked deliberately. The inline
		// `publishingTopicPlanningAnalysis.findFirst` this activity used to run
		// still answers with the AI document; the resolver answers with the
		// author's override. With only one stocked, an activity reading the
		// wrong one would get nothing and the `not.toContain` would pass for
		// the wrong reason.
		analysisFindFirst.mockResolvedValue({ content: AI });
		getEffectivePlanningAnalysis.mockResolvedValue({
			// The REAL resolver, not a hand-built shape — a hand-built one
			// would encode this file's guess about which half a revision
			// replaces, which is exactly the thing under test.
			effective: effectivePlanningAnalysis({
				ai: AI,
				revision: {
					body: "USER PROSE: what the author actually wants said.",
					sourceAnalysisVersion: 1,
				},
			}),
			aiVersion: 1,
			revisionVersion: 1,
			sourceAnalysisVersion: 1,
			author: { id: "user-1", name: "An Author" },
			revisionCreatedAt: new Date(),
		});

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		expect(prompt).toContain("USER PROSE");
		expect(prompt).not.toContain("AI ANGLE");
	});

	it("scopes the resolver read by BOTH ids", async () => {
		await run();

		expect(getEffectivePlanningAnalysis).toHaveBeenCalledWith({
			topicId: "topic-1",
			projectId: "proj-1",
		});
	});

	it("falls back to the AI's own prose when nobody has edited it", async () => {
		// The unedited path must still reach the model. A resolver wired in
		// but never producing prose would look identical to no analysis at
		// all, and every other test in this file passes either way.
		getEffectivePlanningAnalysis.mockResolvedValue({
			effective: effectivePlanningAnalysis({ ai: AI, revision: null }),
			aiVersion: 1,
			revisionVersion: null,
			sourceAnalysisVersion: 1,
			author: null,
			revisionCreatedAt: null,
		});

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		expect(prompt).toContain("AI ANGLE");
		expect(prompt).toContain(renderAnalysisProse(AI));
	});
});

describe("generateShortPostActivity — what it persists", () => {
	it("reports READY on the happy path", async () => {
		await expect(run()).resolves.toEqual({ status: "READY" });
	});

	it("reports SUPERSEDED rather than throwing when the CAS is lost", async () => {
		completeTopicDraft.mockResolvedValue({
			persisted: false,
			reason: "superseded",
		});

		await expect(run()).resolves.toEqual({
			status: "SUPERSEDED",
			refusalReason: "superseded",
		});
	});

	it("fails non-retryably when the model output does not validate FR16's exactly-three contract", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				options: MODEL_OUTPUT.options.slice(0, 2),
			},
			usage: {},
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_SHORT_POST_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completeTopicDraft).not.toHaveBeenCalled();
	});
});
