import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The refusal path, driven through the REAL activity exports, for the two
 * publishing generation activities that have no suite of their own.
 *
 * `generate-blog-post.ts` and `generate-short-post.ts` have only prompt-builder
 * tests. Their authorization guard was covered by nothing at all before this
 * file, and the family AST check that arrived with it proves the call is written
 * in the right place — not that it executes, and not that a refusal actually
 * stops the run. Those are different claims, and only the second one is the
 * guarantee.
 *
 * Both directions are asserted, and the positive one is not optional: "the model
 * factory was never called" is also true of an activity that threw earlier for
 * an unrelated reason, so without a case proving the same fixture DOES reach the
 * factory when authorized, the refusal case distinguishes nothing.
 */

const topicFindFirst = vi.fn();
const analysisFindFirst = vi.fn();
const userFindMany = vi.fn();
const checkPublishingGenerationActor = vi.fn();
const getBoundPromptForAgent = vi.fn();
const listTopicDecisions = vi.fn();
const completeTopicDraft = vi.fn();
const seedWorkingDraftIfAbsent = vi.fn();
vi.mock("@repo/database", () => ({
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
	getBoundPromptForAgent: (...a: unknown[]) => getBoundPromptForAgent(...a),
	listTopicDecisions: (...a: unknown[]) => listTopicDecisions(...a),
	completeTopicDraft: (...a: unknown[]) => completeTopicDraft(...a),
	seedWorkingDraftIfAbsent: (...a: unknown[]) =>
		seedWorkingDraftIfAbsent(...a),
}));

const getAIModelWithMetadata = vi.fn();
const generateObject = vi.fn();
vi.mock("@repo/ai", () => ({
	generateObject: (...a: unknown[]) => generateObject(...a),
	getAIModelWithMetadata: (...a: unknown[]) => getAIModelWithMetadata(...a),
}));

const getProjectFunctionTagClause = vi.fn();
vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: (...a: unknown[]) =>
		getProjectFunctionTagClause(...a),
}));

const computeMaxOutputTokenBudget = vi.fn();
vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeMaxOutputTokenBudget: (...a: unknown[]) =>
		computeMaxOutputTokenBudget(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const collectPlanningContext = vi.fn();
vi.mock("../../publishing-planning/collect-planning-context", () => ({
	collectPlanningContext: (...a: unknown[]) => collectPlanningContext(...a),
}));

import { generateBlogPostActivity } from "../../publishing-blog-post/generate-blog-post";
import { generateShortPostActivity } from "../../publishing-short-post/generate-short-post";

const TOPIC = {
	id: "topic-1",
	title: "Faster incremental builds",
	pitch: "Builds now reuse a warm cache.",
	angle: "delivery velocity",
	subject: "build caching",
	relevantFunctionTags: ["BACKEND"],
	postTypeRecommendations: [],
	contributorUserIds: ["user-2"],
	provenance: {},
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

/**
 * The positive control stops HERE rather than running a whole generation: what
 * it has to prove is that the fixture reaches model resolution at all.
 */
const REACHED_THE_FACTORY = new Error("reached the model factory");

const INPUT = {
	draftId: "draft-1",
	topicId: "topic-1",
	projectId: "proj-1",
	organizationId: "org-1",
	actorUserId: "user-1",
	guidance: null,
};

const ACTIVITIES = [
	{
		name: "generateBlogPostActivity",
		run: () => generateBlogPostActivity(INPUT),
	},
	{
		name: "generateShortPostActivity",
		run: () => generateShortPostActivity(INPUT),
	},
] as const;

beforeEach(() => {
	vi.clearAllMocks();
	topicFindFirst.mockResolvedValue(TOPIC);
	analysisFindFirst.mockResolvedValue(null);
	userFindMany.mockResolvedValue([{ id: "user-2", name: "A Contributor" }]);
	checkPublishingGenerationActor.mockResolvedValue({ ok: true });
	getBoundPromptForAgent.mockResolvedValue(null);
	listTopicDecisions.mockResolvedValue([]);
	collectPlanningContext.mockResolvedValue(CONTEXT_RESULT);
	getProjectFunctionTagClause.mockResolvedValue("");
	computeMaxOutputTokenBudget.mockReturnValue(8192);
	getAIModelWithMetadata.mockRejectedValue(REACHED_THE_FACTORY);
});

describe.each(ACTIVITIES)("$name — the refusal path", ({ run }) => {
	it("reaches the model factory when the actor IS authorized", async () => {
		// The positive control. Without it the refusal cases below could pass on
		// an activity that never gets near a model for some other reason.
		await expect(run()).rejects.toBe(REACHED_THE_FACTORY);

		expect(getAIModelWithMetadata).toHaveBeenCalledTimes(1);
	});

	it("asks about the PROJECT, with the organization the run was queued under", async () => {
		await run().catch(() => {});

		expect(checkPublishingGenerationActor).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			actorUserId: "user-1",
		});
	});

	it("refuses an unauthorized actor before resolving any model", async () => {
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

	it("refuses a project that left the organization before resolving any model", async () => {
		checkPublishingGenerationActor.mockResolvedValue({
			ok: false,
			reason: "TENANT_MISMATCH",
			currentOrganizationId: "org-2",
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_TENANT_MISMATCH",
			nonRetryable: true,
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("collects no source material for a refused run", async () => {
		// The guard sits above the collection fan-out as well as the model call.
		// A refusal that still read the project's documents, transcripts and pull
		// requests would have done the part that matters before declining the
		// part that is billed.
		checkPublishingGenerationActor.mockResolvedValue({
			ok: false,
			reason: "NOT_AUTHORIZED",
			currentOrganizationId: "org-1",
		});

		await run().catch(() => {});

		expect(collectPlanningContext).not.toHaveBeenCalled();
		expect(getBoundPromptForAgent).not.toHaveBeenCalled();
	});

	it("never writes a draft on the refusal path", async () => {
		checkPublishingGenerationActor.mockResolvedValue({
			ok: false,
			reason: "NOT_AUTHORIZED",
			currentOrganizationId: "org-1",
		});

		await run().catch(() => {});

		expect(completeTopicDraft).not.toHaveBeenCalled();
		expect(seedWorkingDraftIfAbsent).not.toHaveBeenCalled();
	});
});
