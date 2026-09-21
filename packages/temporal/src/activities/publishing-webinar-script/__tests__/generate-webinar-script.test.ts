import { join } from "node:path";
import {
	effectivePlanningAnalysis,
	renderAnalysisProse,
} from "@repo/utils/publishing-analysis-prose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseValueImports } from "../../publishing-shared/__tests__/_ast-guards";
import { SETTLED_DECISIONS_HEADING } from "../../publishing-shared/settled-approvals";

/**
 * The Webinar / Demo Script LLM activity (Fizzy #1988, Phase 2D-1).
 *
 * The family's established guards are pinned by its siblings; what is NEW here,
 * and therefore what most of this file is about, is three things:
 *
 *  1. THE RESTRICTION SPLIT, on this type's own extra set.
 *     `restrictsPostType(thread, "WEBINAR_SCRIPT")` matches the same three extra
 *     kinds the case study's set does — CLAIM_STRENGTH, AUDIENCE_SCOPE,
 *     CODEBASE_DETAIL — and while unresolved none of them is a subject to omit
 *     (two are framing questions, CODEBASE_DETAIL is a disclosure question), so
 *     they must land in `openQuestionSubjects`, never in the "NOT approved for
 *     use" list.
 *  2. THE ASSET CLAMP, shared with the case study's algorithm but with its own
 *     call site: `suggestedAssets.confirmed` / `.needsConfirmation` are NESTED
 *     under `suggestedAssets`, unlike the case study's top-level
 *     `confirmedAssets` / `assetsNeedingConfirmation`. There is no
 *     `customerIdentity` / `metricsBasis`-shaped enum on this schema, so the
 *     clamp is the asset half only — and UNLIKE the case study, this activity
 *     persists `generation.clamped.assetKinds` alongside `.assets`.
 *  3. `generation.revisionVersion` / `generation.aiVersion` (DV5, spec §5.6) —
 *     neither sibling persists these. Both must come from the SAME
 *     `getEffectivePlanningAnalysis` call that built the prompt context.
 *
 * `@repo/utils/publishing-restrictions` and `@repo/utils/publishing-asset-clamp`
 * are deliberately NOT mocked. The whole question in (1) and (2) is which real
 * predicate/algorithm routes which real input, and a stubbed one would encode
 * this file's guess about that instead of measuring it.
 */

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const generateObject = vi.fn();
const getAIModelWithMetadata = vi.fn();
vi.mock("@repo/ai", () => ({
	generateObject: (...a: unknown[]) => generateObject(...a),
	getAIModelWithMetadata: (...a: unknown[]) => getAIModelWithMetadata(...a),
	// Faithful enough to discriminate, which is all the activity asks of it:
	// the AI SDK names this error class "AI_NoObjectGeneratedError", and the
	// activity only ever calls `isInstance`. A mock that answered `true` for
	// everything would turn every provider outage into a schema complaint.
	NoObjectGeneratedError: {
		isInstance: (e: unknown) =>
			e instanceof Error && e.name === "AI_NoObjectGeneratedError",
	},
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
const projectFindUnique = vi.fn();
const projectMemberFindMany = vi.fn();
const checkPublishingGenerationActor = vi.fn();
const getBoundPromptForAgent = vi.fn();
const listTopicDecisions = vi.fn();
const getEffectivePlanningAnalysis = vi.fn();
const completeTopicDraft = vi.fn();
const seedWorkingDraftIfAbsent = vi.fn();
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
			// `resolveContributorNames` fences name resolution to the people who
			// still have project access before it reads a single user row. Here
			// everyone submitted passes: what the fence actually admits is pinned
			// in publishing-shared/__tests__/contributor-names.test.ts, and a
			// second opinion about it in this file would be a guess.
			project: {
				findUnique: (...a: unknown[]) => projectFindUnique(...a),
			},
			projectMember: {
				findMany: (...a: unknown[]) => projectMemberFindMany(...a),
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
		seedWorkingDraftIfAbsent: (...a: unknown[]) =>
			seedWorkingDraftIfAbsent(...a),
	};
});

const { logger } = vi.hoisted(() => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/logs", () => ({ logger }));

const collectPlanningContext = vi.fn();
vi.mock("../../publishing-planning/collect-planning-context", () => ({
	collectPlanningContext: (...a: unknown[]) => collectPlanningContext(...a),
}));

import { generateWebinarScriptActivity } from "../generate-webinar-script";

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
	title: "Faster incremental builds: a live demo",
	sessionPurpose: "Show how build caching cuts CI wait times.",
	recommendedAudience: "Platform engineers evaluating the toolchain.",
	suggestedLength: "20 minutes",
	presenterNotes: null,
	openingTalkTrack: "Builds used to start cold every time.",
	agenda: ["Why builds were slow", "What changed", "Live demo"],
	keyMessage: "Incremental caching turns a dead build into a warm one.",
	demoFlow: [
		{
			name: "Warm cache walkthrough",
			whatToShow: "A build finishing in seconds against a warm cache.",
			talkTrack: "Watch how the second run reuses the cache.",
			audienceTakeaway: "Caching removes the wait, not the correctness.",
		},
	],
	supportingDetails: {
		problem: "Cold builds blocked every merge.",
		solution: "A shared, content-addressed cache.",
	},
	suggestedAssets: {
		confirmed: [],
		needsConfirmation: ["customer logo"],
	},
	closingTalkTrack: "That's the whole loop, end to end.",
	suggestedCta: "Try the cache on your own pipeline this week.",
	releaseStatus: "SHIPPED",
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

/** An OPEN question thread of one decision kind. */
function openQuestion(decisionKind: string, subject: string | null = null) {
	return {
		root: {
			kind: "QUESTION",
			status: "OPEN",
			decisionKind,
			subject,
			summary: null,
		},
		replies: [],
	};
}

/** An ANSWERED question thread, which is an instruction rather than a limit. */
function answeredQuestion(
	decisionKind: string,
	subject: string,
	answer: string,
	createdAt = "2026-09-01T09:00:00Z",
	root: Record<string, unknown> = {},
) {
	return {
		root: {
			id: `root-${decisionKind}-${subject}`,
			createdAt: new Date(createdAt),
			kind: "QUESTION",
			status: "RESOLVED",
			decisionKind,
			subject,
			// The question the member was shown, as reconciliation stores it,
			// with the folded list stamped by the version that wrote it.
			summary: `What may the piece say about ${subject}?`,
			analysisVersion: 1,
			foldedQuestions: [] as string[],
			foldedQuestionsVersion: 1,
			...root,
		},
		replies: [
			{
				id: `reply-${decisionKind}-${subject}`,
				createdAt: new Date(createdAt),
				status: "RESOLVED",
				authorType: "USER",
				content: answer,
			},
		],
	};
}

/**
 * A SOFT-CLOSED question: a regenerated analysis stopped raising it and nobody
 * answered it. Its `summary` is the model's question text, as
 * `reconcileTopicQuestions` stores it.
 */
function softClosedQuestion(
	decisionKind: string,
	subject: string | null,
	question: string,
) {
	return {
		root: {
			kind: "QUESTION",
			status: "POSSIBLY_RESOLVED",
			decisionKind,
			subject,
			summary: question,
		},
		replies: [],
	};
}

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
	// Both conditional on the activity's OWN project id ("proj-1"), not
	// unconditional: an unconditional mock answers the same way no matter what
	// id the fence asked about, so it cannot tell a correctly-scoped fence from
	// one asked about the wrong project entirely (e.g. `topicId` passed where
	// `projectId` belongs). See "contributor fence scope" below.
	projectFindUnique.mockImplementation(
		async (args: { where: { id: string } }) =>
			args.where.id === "proj-1"
				? { userId: "project-owner", organizationId: null }
				: null,
	);
	projectMemberFindMany.mockImplementation(
		async (args: {
			where: { projectId: string; userId: { in: string[] } };
		}) =>
			args.where.projectId === "proj-1"
				? args.where.userId.in.map((userId) => ({ userId }))
				: [],
	);
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
	seedWorkingDraftIfAbsent.mockResolvedValue({ status: "seeded" });
});

const run = (overrides: Record<string, unknown> = {}) =>
	generateWebinarScriptActivity({
		draftId: "draft-1",
		topicId: "topic-1",
		projectId: "proj-1",
		organizationId: "org-1",
		actorUserId: "user-1",
		guidance: null,
		...overrides,
	});

/** The document as it was written, minus the generation metadata. */
const persistedContent = () => completeTopicDraft.mock.calls[0]?.[0]?.content;
/** The whole first argument `completeTopicDraft` was called with. */
const persistedDraft = () => completeTopicDraft.mock.calls[0]?.[0];

describe("generateWebinarScriptActivity — tenancy and actor revalidation", () => {
	it("re-scopes the topic read by projectId", async () => {
		await run();

		expect(topicFindFirst.mock.calls[0]?.[0]?.where).toEqual({
			id: "topic-1",
			projectId: "proj-1",
		});
	});

	it("fails closed when the topic does not resolve inside the project", async () => {
		// DV16: a real topic id belonging to another project must be
		// indistinguishable from a deleted one.
		topicFindFirst.mockResolvedValue(null);

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_TENANT_MISMATCH",
			nonRetryable: true,
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("never reaches the model factory when the actor is no longer authorized", async () => {
		// The second assertion is the one that matters. Throwing is easy to get
		// right by accident; what this guard exists for is that no model is
		// resolved and no source collected under a revoked collaborator's
		// identity, and only "the factory was never called" proves the check
		// runs BEFORE resolution rather than beside it.
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

	it("refuses when the project has left the organization the run was queued under", async () => {
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

	it("re-checks the actor even when the run carries no organization", async () => {
		// The branch is unreachable in production (ADR-018 fail-closes a
		// project with no organization); a fail-closed unit case, not coverage
		// of a live path.
		checkPublishingGenerationActor.mockResolvedValue({
			ok: false,
			reason: "NOT_AUTHORIZED",
			currentOrganizationId: null,
		});

		await expect(run({ organizationId: null })).rejects.toMatchObject({
			type: "PUBLISHING_ACTOR_INVALID",
		});
		expect(checkPublishingGenerationActor).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			actorUserId: "user-1",
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("passes a null organization through to prompt resolution", async () => {
		// `organizationId ?? undefined` is load-bearing in
		// `getBoundPromptForAgent`.
		await run({ organizationId: null });

		expect(getBoundPromptForAgent.mock.calls[0]?.[0]?.organizationId).toBe(
			undefined,
		);
	});

	it("resolves the webinar script's own bound prompt", async () => {
		await run();

		expect(getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "publishing_topic_webinar_script",
				documentType: "GENERAL",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
	});

	it("bills the run under its own job type", async () => {
		await run();

		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			expect.objectContaining({ jobType: "publishing-webinar-script" }),
		);
	});
});

describe("generateWebinarScriptActivity — contributor override", () => {
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
		topicFindFirst.mockResolvedValue({
			...TOPIC,
			contributorUserIds: ["ai-user"],
			contributorsOverridden: true,
			userContributorUserIds: [],
		});

		await run();

		expect(userFindMany).not.toHaveBeenCalled();
	});
});

describe("generateWebinarScriptActivity — contributor fence scope", () => {
	// The mocks above are conditional on "proj-1" precisely so these two can
	// fail: an unconditional `projectFindUnique` / `projectMemberFindMany`
	// answers identically no matter which project id the fence asked about, so
	// swapping `projectId` for `topicId` at the call site would go just as
	// green as the correct call.
	it("resolves contributor names against the activity's OWN project id, not the topic id", async () => {
		await run();

		expect(projectFindUnique.mock.calls[0]?.[0]?.where).toEqual({
			id: "proj-1",
		});
	});

	it("yields no contributor names when the fence is asked about a project it does not recognize", async () => {
		await run({ projectId: "proj-9" });

		expect(userFindMany).not.toHaveBeenCalled();
	});
});

describe("generateWebinarScriptActivity — the restriction split", () => {
	it("routes a shared safety-critical kind into the NOT-approved block", async () => {
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "example-org"),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		const restricted = prompt.slice(
			prompt.indexOf("## Unresolved approvals for this topic"),
		);
		expect(restricted).toContain("example-org");
		expect(prompt).not.toMatch(
			/Unresolved questions that constrain this content type/,
		);
	});

	it("routes a CLAIM_STRENGTH thread into openQuestionSubjects for WEBINAR_SCRIPT", async () => {
		// `isRestrictingThread` returns FALSE for CLAIM_STRENGTH — it is not a
		// kind that constrains every content type. Only
		// `restrictsPostType(thread, "WEBINAR_SCRIPT")` sees it, and this case
		// is what proves the activity calls the per-type predicate rather than
		// the shared one.
		listTopicDecisions.mockResolvedValue([
			openQuestion("CLAIM_STRENGTH", "the latency result"),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		const openHeading = prompt.indexOf(
			"## Unresolved questions that constrain this content type",
		);
		expect(openHeading).toBeGreaterThan(-1);
		expect(prompt.slice(openHeading)).toContain("the latency result");
		expect(prompt).not.toMatch(/Unresolved approvals for this topic/);
	});

	it("routes AUDIENCE_SCOPE and CODEBASE_DETAIL the same way", async () => {
		listTopicDecisions.mockResolvedValue([
			openQuestion("AUDIENCE_SCOPE", "who this session is for"),
			openQuestion("CODEBASE_DETAIL", "how much of the resolver to show"),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		expect(prompt).not.toMatch(/Unresolved approvals for this topic/);
		const openHeading = prompt.indexOf(
			"## Unresolved questions that constrain this content type",
		);
		expect(prompt.slice(openHeading)).toContain("who this session is for");
		expect(prompt.slice(openHeading)).toContain(
			"how much of the resolver to show",
		);
	});

	it("keeps an AUDIENCE_SCOPE thread out of the NOT-approved block", async () => {
		// Putting it there would instruct the model to strip the audience
		// framing — on a format read aloud live, the opposite of caution.
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "example-org"),
			openQuestion("AUDIENCE_SCOPE", "who this is written for"),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		const restrictedHeading = prompt.indexOf(
			"## Unresolved approvals for this topic",
		);
		const openHeading = prompt.indexOf(
			"## Unresolved questions that constrain this content type",
		);
		expect(restrictedHeading).toBeGreaterThan(-1);
		expect(openHeading).toBeGreaterThan(restrictedHeading);
		expect(prompt.slice(restrictedHeading, openHeading)).not.toContain(
			"who this is written for",
		);
		expect(prompt.slice(openHeading)).toContain("who this is written for");
	});

	it("records restricted subjects as {kind, label} objects, not bare strings", async () => {
		// A stored draft has to be able to say WHICH rule set was in force. A
		// later change to SAFETY_CRITICAL_KINDS would otherwise silently
		// reinterpret every draft already on disk.
		listTopicDecisions.mockResolvedValue([
			openQuestion("METRICS_APPROVAL", "the adoption number"),
			openQuestion("CODEBASE_DETAIL", "how much of the resolver to show"),
		]);

		await run();

		const generation = persistedContent().generation;
		expect(generation.restrictedSubjects).toEqual([
			{ kind: "METRICS_APPROVAL", label: "the adoption number" },
		]);
		expect(generation.openQuestionSubjects).toEqual([
			"how much of the resolver to show",
		]);
	});

	it("treats an ANSWERED question as an instruction, not a restriction", async () => {
		listTopicDecisions.mockResolvedValue([
			answeredQuestion(
				"CUSTOMER_NAME",
				"example-org",
				"Yes, we may name them.",
			),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		expect(prompt).not.toMatch(/Unresolved approvals for this topic/);
		expect(prompt).toContain("Yes, we may name them.");
		expect(persistedContent().generation.restrictedSubjects).toEqual([]);
	});

	it("keeps a SOFT-CLOSED safety question restricted", async () => {
		listTopicDecisions.mockResolvedValue([
			softClosedQuestion(
				"CUSTOMER_NAME",
				"example-org",
				"May we name example-org?",
			),
		]);

		await run();

		expect(persistedContent().generation.restrictedSubjects).toEqual([
			{ kind: "CUSTOMER_NAME", label: "example-org" },
		]);
	});
});

describe("generateWebinarScriptActivity — the asset clamp", () => {
	it("demotes a claimed-confirmed asset an OPEN approval is about", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				suggestedAssets: {
					confirmed: ["The Latency Chart", "architecture diagram"],
					needsConfirmation: [],
				},
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("ASSET_APPROVAL", "latency chart"),
		]);

		await run();

		expect(persistedContent().suggestedAssets.confirmed).toEqual([
			"architecture diagram",
		]);
		expect(persistedContent().suggestedAssets.needsConfirmation).toEqual([
			"The Latency Chart",
		]);
		expect(persistedContent().generation.clamped).toEqual({
			assets: ["The Latency Chart"],
			assetKinds: { "The Latency Chart": "ASSET_APPROVAL" },
		});
	});

	it("demotes a claimed-confirmed asset a SOFT-CLOSED approval is about", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				suggestedAssets: {
					confirmed: ["The Latency Chart", "architecture diagram"],
					needsConfirmation: [],
				},
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			softClosedQuestion(
				"ASSET_APPROVAL",
				"latency chart",
				"Is the latency chart approved for use?",
			),
		]);

		await run();

		expect(persistedContent().suggestedAssets.confirmed).toEqual([
			"architecture diagram",
		]);
		expect(persistedContent().suggestedAssets.needsConfirmation).toEqual([
			"The Latency Chart",
		]);
		expect(persistedContent().generation.clamped).toEqual({
			assets: ["The Latency Chart"],
			assetKinds: { "The Latency Chart": "ASSET_APPROVAL" },
		});
	});

	it("demotes on INTERNAL_UI and VIDEO_WALKTHROUGH, not just ASSET_APPROVAL", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				suggestedAssets: {
					confirmed: [
						"admin console screenshot",
						"product walkthrough video",
						"public roadmap slide",
					],
					needsConfirmation: [],
				},
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("INTERNAL_UI", "admin console screenshot"),
			openQuestion("VIDEO_WALKTHROUGH", "product walkthrough video"),
		]);

		await run();

		expect(persistedContent().suggestedAssets.confirmed).toEqual([
			"public roadmap slide",
		]);
		expect(persistedContent().generation.clamped.assets).toEqual([
			"admin console screenshot",
			"product walkthrough video",
		]);
		expect(persistedContent().generation.clamped.assetKinds).toEqual({
			"admin console screenshot": "INTERNAL_UI",
			"product walkthrough video": "VIDEO_WALKTHROUGH",
		});
	});

	it("resolves an asset matching TWO restricting kinds to the first in iteration order", async () => {
		// Pinning `matchingRestrictedKind`'s tie-break for THIS content type's
		// persisted `assetKinds`, per the plan's own note: no existing test
		// exercises it, because the case study never reads the kind. Iteration
		// order of `ASSET_RESTRICTING_KINDS` is ASSET_APPROVAL, INTERNAL_UI,
		// VIDEO_WALKTHROUGH — so an asset named by both an open ASSET_APPROVAL
		// and an open INTERNAL_UI thread is attributed to ASSET_APPROVAL.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				suggestedAssets: {
					confirmed: ["dashboard capture"],
					needsConfirmation: [],
				},
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("INTERNAL_UI", "dashboard capture"),
			openQuestion("ASSET_APPROVAL", "dashboard capture"),
		]);

		await run();

		expect(persistedContent().generation.clamped.assetKinds).toEqual({
			"dashboard capture": "ASSET_APPROVAL",
		});
	});

	it("does not list a demoted asset twice when the model already hedged", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				suggestedAssets: {
					confirmed: ["customer logo"],
					needsConfirmation: ["customer logo"],
				},
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("ASSET_APPROVAL", "customer logo"),
		]);

		await run();

		expect(persistedContent().suggestedAssets.confirmed).toEqual([]);
		expect(persistedContent().suggestedAssets.needsConfirmation).toEqual([
			"customer logo",
		]);
	});

	it("de-duplicates a demoted asset against a differently-cased hedge", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				suggestedAssets: {
					confirmed: ["The Latency Chart"],
					needsConfirmation: ["the latency chart"],
				},
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("ASSET_APPROVAL", "latency chart"),
		]);

		await run();

		expect(persistedContent().suggestedAssets.needsConfirmation).toEqual([
			"the latency chart",
		]);
		expect(persistedContent().generation.clamped.assets).toEqual([
			"The Latency Chart",
		]);
	});

	it("leaves every confirmed asset standing when no ASSET-restricting kind is open", async () => {
		// A framing question (CLAIM_STRENGTH here) is not a claim about an
		// asset at all.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				suggestedAssets: {
					confirmed: ["architecture diagram"],
					needsConfirmation: [],
				},
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "architecture diagram"),
			openQuestion("CLAIM_STRENGTH", "architecture diagram"),
		]);

		await run();

		expect(persistedContent().suggestedAssets.confirmed).toEqual([
			"architecture diagram",
		]);
		expect(persistedContent().generation.clamped).toEqual({});
	});

	it("stays absent (never []) on the clean run — an empty array would fire the log gate", async () => {
		await run();

		expect(persistedContent().generation.clamped.assets).toBeUndefined();
		expect(
			persistedContent().generation.clamped.assetKinds,
		).toBeUndefined();
	});

	it("leaves an ANSWERED asset approval alone — it is not a restriction", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				suggestedAssets: {
					confirmed: ["latency chart"],
					needsConfirmation: [],
				},
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			answeredQuestion(
				"ASSET_APPROVAL",
				"latency chart",
				"Approved for external use.",
			),
		]);

		await run();

		expect(persistedContent().suggestedAssets.confirmed).toEqual([
			"latency chart",
		]);
		expect(persistedContent().generation.clamped).toEqual({});
	});
});

describe("generateWebinarScriptActivity — the write surface", () => {
	// The card's guarantee: generating a webinar script publishes nothing,
	// pushes nothing to a feed, creates no asset and mutates no tag.
	it("imports ONLY the reads and the two writes the guarantee allows", () => {
		expect(
			databaseValueImports(
				join(__dirname, "../generate-webinar-script.ts"),
			),
		).toEqual([
			"completeTopicDraft",
			"db",
			"effectiveContributorUserIds",
			"getBoundPromptForAgent",
			"getEffectivePlanningAnalysis",
			"listTopicDecisions",
			"logDraftRefusal",
			"seedWorkingDraftIfAbsent",
		]);
	});

	it("uses the create-only seed on the happy path", async () => {
		await run();

		expect(seedWorkingDraftIfAbsent).toHaveBeenCalledTimes(1);
	});

	it("seeds through the SHARED composer, carrying the title into the body", async () => {
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, title: "A webinar script title" },
			usage: {},
		});

		await run();

		expect(seedWorkingDraftIfAbsent).toHaveBeenCalledWith(
			expect.objectContaining({
				postType: "WEBINAR_SCRIPT",
				sourceDraftId: "draft-1",
				updatedById: "user-1",
				body: expect.stringContaining("# A webinar script title"),
			}),
		);
	});

	it("reports no seeding when the topic already has a draft", async () => {
		seedWorkingDraftIfAbsent.mockResolvedValue({
			status: "already_exists",
		});

		const result = await run();

		expect(result).toEqual({ status: "READY", seededWorkingDraft: false });
	});

	it("writes nothing at all when the output fails schema validation", async () => {
		generateObject.mockResolvedValue({
			object: { title: "A title" },
			usage: {},
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_WEBINAR_SCRIPT_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completeTopicDraft).not.toHaveBeenCalled();
		expect(seedWorkingDraftIfAbsent).not.toHaveBeenCalled();
	});

	it("reports a schema failure RAISED BY THE SDK as the same authored class", async () => {
		// The case above mocks `generateObject` RETURNING an invalid object, so
		// it exercises this module's own `safeParse`. Production never took that
		// path: `generateObject` validates against the zod schema itself and
		// throws `NoObjectGeneratedError` before returning, so the authored
		// message — "the model returned a draft that did not match the expected
		// shape; generating again usually clears it" — was unreachable, and a
		// reader was shown the neutral "the reason is recorded in the run log"
		// instead. Both paths now end in the same class.
		const sdkError = new Error(
			"No object generated: response did not match schema.",
		);
		sdkError.name = "AI_NoObjectGeneratedError";
		generateObject.mockRejectedValue(sdkError);

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_WEBINAR_SCRIPT_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completeTopicDraft).not.toHaveBeenCalled();
		expect(seedWorkingDraftIfAbsent).not.toHaveBeenCalled();
	});

	it("still lets an unrelated provider failure through untouched", async () => {
		// The discrimination that makes the branch above safe. A provider outage
		// is not a schema complaint, and telling a reader to "generate again" is
		// only honest for the one that is.
		generateObject.mockRejectedValue(new Error("provider unavailable"));

		await expect(run()).rejects.toThrow("provider unavailable");
		expect(completeTopicDraft).not.toHaveBeenCalled();
	});

	it("rejects a whitespace-only title instead of seeding a headless draft", async () => {
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, title: "   " },
			usage: {},
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_WEBINAR_SCRIPT_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completeTopicDraft).not.toHaveBeenCalled();
		expect(seedWorkingDraftIfAbsent).not.toHaveBeenCalled();
	});

	it("does not seed after a lost CAS, and reports SUPERSEDED rather than throwing", async () => {
		completeTopicDraft.mockResolvedValue({
			persisted: false,
			reason: "superseded",
		});

		await expect(run()).resolves.toEqual({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
			refusalReason: "superseded",
		});
		expect(seedWorkingDraftIfAbsent).not.toHaveBeenCalled();
	});
});

describe("generateWebinarScriptActivity — what it persists", () => {
	it("reports READY and a seeded draft on the happy path", async () => {
		await expect(run()).resolves.toEqual({
			status: "READY",
			seededWorkingDraft: true,
		});
	});

	it("persists the draft, its source refs and the model", async () => {
		await run();

		expect(completeTopicDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "draft-1",
				projectId: "proj-1",
				model: "test-model",
				sourceRefs: CONTEXT_RESULT.sourceRefs,
				promptSource: "DEFAULT_UNBOUND",
			}),
		);
	});

	it("records DEFAULT_UNBOUND when no prompt binding resolves", async () => {
		// The only per-draft signal that the seed has not bound a prompt yet
		// (§6.3 step 7 makes an unseeded prompt a live possibility).
		await run();

		expect(persistedDraft().promptSource).toBe("DEFAULT_UNBOUND");
	});

	it("records DEFAULT_RENDER_FAILED when a bound body renders to nothing", async () => {
		getBoundPromptForAgent.mockResolvedValue({
			id: "p-1",
			format: "HANDLEBARS",
			version: { content: "   ", version: 3 },
		});

		await run();

		expect(persistedDraft().promptSource).toBe("DEFAULT_RENDER_FAILED");
	});

	it("records BOUND and uses the bound body", async () => {
		getBoundPromptForAgent.mockResolvedValue({
			id: "p-1",
			format: "HANDLEBARS",
			version: { content: "Write up {{{topic_title}}}.", version: 2 },
		});

		await run();

		expect(persistedDraft().promptSource).toBe("BOUND");
		expect(generateObject.mock.calls[0]?.[0]?.prompt).toContain(
			"Faster incremental builds",
		);
	});

	it("appends the project's function-tag clause", async () => {
		getProjectFunctionTagClause.mockResolvedValue(
			"ROLE COMPOSITION: backend",
		);

		await run();

		expect(generateObject.mock.calls[0]?.[0]?.prompt).toContain(
			"ROLE COMPOSITION: backend",
		);
	});

	it("carries the run's guidance onto the stored draft", async () => {
		await run({ guidance: "Aim it at platform teams." });

		expect(persistedContent().generation.guidance).toBe(
			"Aim it at platform teams.",
		);
	});

	it("feeds a non-null currentDraft to the prompt builder and records the refinement flag", async () => {
		await run({
			currentDraft: "REFINE-CANARY: the saved working script.",
		});

		expect(persistedContent().generation.refinedFromWorkingDraft).toBe(
			true,
		);
		expect(generateObject.mock.calls[0]?.[0]?.prompt).toContain(
			"REFINE-CANARY: the saved working script.",
		);
	});

	it("persists the analysis versions it actually read", async () => {
		// revisionVersion identifies the PROSE and aiVersion the structured
		// DATA: effectivePlanningAnalysis composes them from different rows, so
		// one alone would not say which analysis produced this draft. Both
		// come from the SAME getEffectivePlanningAnalysis call that built the
		// prompt context.
		getEffectivePlanningAnalysis.mockResolvedValue({
			effective: null,
			aiVersion: 7,
			revisionVersion: 3,
			sourceAnalysisVersion: 3,
			author: null,
			revisionCreatedAt: null,
		});

		await run();

		expect(persistedContent().generation).toMatchObject({
			revisionVersion: 3,
			aiVersion: 7,
		});
	});

	it("persists null analysis versions when the topic has never been analysed", async () => {
		await run();

		expect(persistedContent().generation).toMatchObject({
			revisionVersion: null,
			aiVersion: null,
		});
	});
});

describe("generateWebinarScriptActivity — the model call", () => {
	it("disables strict JSON schema", async () => {
		await run();

		expect(generateObject.mock.calls[0]?.[0]?.providerOptions).toEqual({
			openai: { strictJsonSchema: false },
		});
	});

	it("tracks usage", async () => {
		await run();
		expect(trackUsage).toHaveBeenCalled();
	});

	it("bounds the generation against the full prompt it is about to send", async () => {
		getProjectFunctionTagClause.mockResolvedValue(
			"ROLE COMPOSITION: backend",
		);

		await run();

		const sentPrompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		expect(computeMaxOutputTokenBudget).toHaveBeenCalledWith(
			expect.anything(),
			{ promptChars: sentPrompt.length },
		);
	});

	it("omits maxOutputTokens entirely when the helper declines to set one", async () => {
		computeMaxOutputTokenBudget.mockReturnValue(undefined);

		await run();

		expect(generateObject.mock.calls[0]?.[0]).not.toHaveProperty(
			"maxOutputTokens",
		);
	});
});

describe("generateWebinarScriptActivity — the effective analysis reaches the prompt", () => {
	const AI = {
		topicAngle: "AI ANGLE: the model's own framing.",
		contentTypes: { recommended: [{ type: "Tweet" }] },
	};

	it("feeds the user's edited prose to the prompt, not the AI's original", async () => {
		analysisFindFirst.mockResolvedValue({ content: AI });
		getEffectivePlanningAnalysis.mockResolvedValue({
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
		expect(analysisFindFirst).not.toHaveBeenCalled();
	});

	it("scopes the resolver read by BOTH ids", async () => {
		await run();

		expect(getEffectivePlanningAnalysis).toHaveBeenCalledWith({
			topicId: "topic-1",
			projectId: "proj-1",
		});
		// A second call would be a defect even if both calls used the same
		// ids — the versions persisted below must come from the SAME read.
		expect(getEffectivePlanningAnalysis).toHaveBeenCalledTimes(1);
	});

	it("falls back to the AI's own prose when nobody has edited it", async () => {
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

describe("generateWebinarScriptActivity — the settled-decisions block", () => {
	const promptSent = () =>
		generateObject.mock.calls[0]?.[0]?.prompt as string;
	const settledSection = () => {
		const prompt = promptSent();
		const at = prompt.indexOf(SETTLED_DECISIONS_HEADING);
		expect(at).toBeGreaterThan(-1);
		return prompt.slice(at);
	};

	it("passes only the approval-relevant settled decisions to its locked clauses", async () => {
		listTopicDecisions.mockResolvedValue([
			answeredQuestion(
				"AUDIENCE_SCOPE",
				"who this session is for",
				"Platform engineers at example-org.",
			),
			answeredQuestion(
				"CUSTOMER_NAME",
				"example-org",
				"Yes, the customer agreed to be named.",
			),
		]);

		await run();

		expect(settledSection()).toContain(
			'- "example-org" - asked: "What may the piece say about example-org?" - answered: "Yes, the customer agreed to be named."',
		);
		expect(settledSection()).not.toContain(
			"Platform engineers at example-org.",
		);
		// Still a settled decision: the body's decisions block carries it.
		expect(promptSent()).toContain("Platform engineers at example-org.");
	});

	it("admits a settled CODEBASE_DETAIL decision — this type's approval rule names an implementation claim", async () => {
		listTopicDecisions.mockResolvedValue([
			answeredQuestion(
				"CODEBASE_DETAIL",
				"how much of the resolver to show",
				"Show the cache dashboard; do not open the source.",
			),
		]);

		await run();

		expect(settledSection()).toContain(
			'- "how much of the resolver to show" - asked: "What may the piece say about how much of the resolver to show?" - answered: "Show the cache dashboard; do not open the source."',
		);
	});

	it("logs when the block cannot list every settled decision", async () => {
		listTopicDecisions.mockResolvedValue(
			Array.from({ length: 21 }, (_, i) =>
				answeredQuestion(
					"ASSET_APPROVAL",
					`asset ${String(i).padStart(2, "0")}`,
					"Approved.",
				),
			),
		);

		await run();

		expect(logger.warn).toHaveBeenCalledWith(
			"[publishing-webinar-script] settled-decisions block truncated",
			{
				draftId: "draft-1",
				topicId: "topic-1",
				projectId: "proj-1",
				contentType: "WEBINAR_SCRIPT",
				listed: 20,
				omitted: 1,
			},
		);
	});

	it("shows the question the member answered and the questions folded into it (Fizzy #1988)", async () => {
		listTopicDecisions.mockResolvedValue([
			answeredQuestion(
				"CUSTOMER_NAME",
				"Customer name and logo",
				"Yes.",
				undefined,
				{
					summary: "May this piece name example-org?",
					analysisVersion: 2,
					foldedQuestions: [
						"May it say example-org was the first trial customer?",
					],
					foldedQuestionsVersion: 2,
				},
			),
		]);

		await run();

		expect(settledSection()).toContain(
			'- "Customer name and logo" - asked: "May this piece name example-org?" also: "May it say example-org was the first trial customer?" - answered: "Yes."',
		);
	});

	const QUESTION_NOT_SHOWN_WARNING =
		"[publishing-webinar-script] settled-decisions entries shown cut or without their question";

	it("logs a listed decision shown without its question — ids and counts, never its text (Fizzy #1988)", async () => {
		listTopicDecisions.mockResolvedValue([
			answeredQuestion(
				"CUSTOMER_NAME",
				"example-org",
				"Yes, the customer agreed to be named.",
				undefined,
				{ summary: null },
			),
		]);

		await run();

		// Precondition: the entry is listed, and its question slot says why.
		expect(settledSection()).toContain(
			'- "example-org" - asked: [question not recorded] - answered: "Yes, the customer agreed to be named."',
		);
		expect(logger.warn).toHaveBeenCalledWith(QUESTION_NOT_SHOWN_WARNING, {
			draftId: "draft-1",
			topicId: "topic-1",
			projectId: "proj-1",
			contentType: "WEBINAR_SCRIPT",
			cutEntries: 0,
			questionNotShown: 1,
		});
	});

	it("logs a listed decision whose answer alone was cut", async () => {
		listTopicDecisions.mockResolvedValue([
			answeredQuestion(
				"CUSTOMER_NAME",
				"example-org",
				`Yes${", in public material".repeat(20)}`,
			),
		]);

		await run();

		expect(settledSection()).toContain('…" [cut to fit]');
		expect(logger.warn).toHaveBeenCalledWith(QUESTION_NOT_SHOWN_WARNING, {
			draftId: "draft-1",
			topicId: "topic-1",
			projectId: "proj-1",
			contentType: "WEBINAR_SCRIPT",
			cutEntries: 1,
			questionNotShown: 0,
		});
	});

	it("does not log it when every listed decision shows its question and its whole answer", async () => {
		listTopicDecisions.mockResolvedValue([
			answeredQuestion(
				"CUSTOMER_NAME",
				"example-org",
				"Yes, the customer agreed to be named.",
			),
		]);

		await run();

		expect(settledSection()).toContain(
			'- "example-org" - asked: "What may the piece say about example-org?" - answered: "Yes, the customer agreed to be named."',
		);
		expect(
			logger.warn.mock.calls.filter(
				([message]) => message === QUESTION_NOT_SHOWN_WARNING,
			),
		).toEqual([]);
	});
});
