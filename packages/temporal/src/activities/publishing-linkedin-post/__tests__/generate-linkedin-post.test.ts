import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LinkedIn Post — the LLM activity (Fizzy #1988, follow-up 2).
 *
 * The harness is the short post's (`generate-short-post.test.ts`), because the
 * two activities share every collaborator. Scoped to what THIS file decides:
 * which threads become restrictions, what it persists, and how it fails. It
 * does not assert the resolved-decisions block or the locked clauses' text —
 * both are rendered by the short post's builders and pinned there.
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
const userFindMany = vi.fn();
const checkPublishingGenerationActor = vi.fn();
const getBoundPromptForAgent = vi.fn();
const listTopicDecisions = vi.fn();
const getEffectivePlanningAnalysis = vi.fn();
const completeTopicDraft = vi.fn();
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		// The REAL implementation: a hand-rolled copy would encode this file's
		// guess of the override semantics instead of measuring them.
		effectiveContributorUserIds: actual.effectiveContributorUserIds,
		logDraftRefusal: vi.fn(),
		db: {
			publishingTopic: {
				findFirst: (...a: unknown[]) => topicFindFirst(...a),
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

import { generateLinkedInPostActivity } from "../generate-linkedin-post";

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
			label: "Result first",
			text: "Our builds now start warm. Here is what changed for the team.",
			estimatedCharacters: 61,
		},
		{
			label: "Question-led",
			text: "What would your team do with the minutes a cold build used to take?",
			estimatedCharacters: 67,
		},
		{
			label: "Story-led",
			text: "Last quarter every build started cold. This quarter none do.",
			estimatedCharacters: 60,
		},
	],
	hashtags: [],
	inputsNeeded: [],
	safetyNote: null,
};

const CONTEXT_RESULT = {
	context: { stories: [], documents: [], transcripts: [], repoPrs: [] },
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

/** A decision thread in the shape `listTopicDecisions` returns. */
function thread(root: Record<string, unknown>) {
	return {
		root: {
			id: `root-${String(root.decisionKind ?? "x")}`,
			kind: "QUESTION",
			status: "OPEN",
			decisionKind: "CUSTOMER_NAME",
			subject: "the customer name",
			summary: "May we name the customer?",
			...root,
		},
		replies: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	topicFindFirst.mockResolvedValue(TOPIC);
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
	generateLinkedInPostActivity({
		draftId: "draft-1",
		topicId: "topic-1",
		projectId: "proj-1",
		organizationId: "org-1",
		actorUserId: "user-1",
		guidance: null,
		...overrides,
	});

/** The `generation.restrictedSubjects` this run persisted. */
async function persistedRestrictions(): Promise<unknown> {
	await run();
	return completeTopicDraft.mock.calls[0]?.[0]?.content?.generation
		?.restrictedSubjects;
}

describe("generateLinkedInPostActivity — tenancy and actor revalidation", () => {
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

describe("generateLinkedInPostActivity — the restriction split", () => {
	it("restricts an OPEN safety-critical question", async () => {
		listTopicDecisions.mockResolvedValue([thread({})]);
		expect(await persistedRestrictions()).toEqual(["the customer name"]);
	});

	it("does NOT restrict an OPEN CLAIM_STRENGTH question — LinkedIn has no per-type extra kinds", async () => {
		// Case Study, Stakeholder Email, Webinar Script and Newsletter Blurb
		// restrict CLAIM_STRENGTH too, through `restrictsPostType`. LinkedIn uses
		// `isRestrictingThread` alone and has no entry in
		// `EXTRA_RESTRICTING_KINDS_BY_POST_TYPE`, so this question constrains
		// none of its drafts. Pinned so adopting the wider predicate is a visible
		// decision rather than a copy-paste from a sibling.
		listTopicDecisions.mockResolvedValue([
			thread({
				decisionKind: "CLAIM_STRENGTH",
				subject: "the speed claim",
			}),
		]);
		expect(await persistedRestrictions()).toEqual([]);
	});

	it("does not restrict a RESOLVED question or a BLOCKER, whatever their kind", async () => {
		listTopicDecisions.mockResolvedValue([
			thread({ status: "RESOLVED" }),
			thread({ kind: "BLOCKER", subject: "an approved screenshot" }),
		]);
		expect(await persistedRestrictions()).toEqual([]);
	});
});

describe("generateLinkedInPostActivity — what it persists", () => {
	it("persists the validated post with its generation record and reports READY", async () => {
		await expect(run()).resolves.toEqual({ status: "READY" });
		expect(completeTopicDraft).toHaveBeenCalledWith({
			id: "draft-1",
			projectId: "proj-1",
			content: {
				...MODEL_OUTPUT,
				generation: {
					promptSource: "DEFAULT_UNBOUND",
					promptId: null,
					promptVersion: null,
					formatOverridden: false,
					restrictedSubjects: [],
					guidance: null,
					refinedFromWorkingDraft: false,
					generatedAt: expect.any(String),
				},
			},
			sourceRefs: CONTEXT_RESULT.sourceRefs,
			model: "test-model",
			promptSource: "DEFAULT_UNBOUND",
			promptId: null,
			promptVersion: null,
		});
		expect(getAIModelWithMetadata.mock.calls[0]?.[1]).toMatchObject({
			jobType: "publishing-linkedin-post",
		});
	});

	it("records a refinement run as refined from the working draft", async () => {
		await run({ currentDraft: "Our builds used to start cold." });
		expect(
			completeTopicDraft.mock.calls[0]?.[0]?.content?.generation
				?.refinedFromWorkingDraft,
		).toBe(true);
	});

	it("reports SUPERSEDED with the refusal reason rather than throwing when the commit is refused", async () => {
		completeTopicDraft.mockResolvedValue({
			persisted: false,
			reason: "superseded",
		});
		await expect(run()).resolves.toEqual({
			status: "SUPERSEDED",
			refusalReason: "superseded",
		});
	});
});

describe("generateLinkedInPostActivity — how it fails", () => {
	it("lets a model failure propagate and commits nothing", async () => {
		// The workflow owns the failure marker; this activity must not swallow
		// the error into a status, or the attempt would never be marked failed.
		generateObject.mockRejectedValue(new Error("provider unavailable"));
		await expect(run()).rejects.toThrow("provider unavailable");
		expect(completeTopicDraft).not.toHaveBeenCalled();
		expect(trackUsage).not.toHaveBeenCalled();
	});

	it("fails non-retryably when the output breaks the exactly-three contract, and commits nothing", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				options: MODEL_OUTPUT.options.slice(0, 2),
			},
			usage: {},
		});
		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_LINKEDIN_POST_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completeTopicDraft).not.toHaveBeenCalled();
	});
});
