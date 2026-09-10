import { join } from "node:path";
import {
	effectivePlanningAnalysis,
	renderAnalysisProse,
} from "@repo/utils/publishing-analysis-prose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseValueImports } from "../../publishing-shared/__tests__/_ast-guards";

/**
 * The Webinar / Demo Script LLM activity (Fizzy #1988, Phase 2D-1).
 *
 * The family's established guards are pinned by its siblings; what is NEW here,
 * and therefore what most of this file is about, is three things:
 *
 *  1. THE RESTRICTION SPLIT, on this type's own extra set.
 *     `restrictsPostType(thread, "WEBINAR_SCRIPT")` matches the same three extra
 *     kinds the case study's set does — CLAIM_STRENGTH, AUDIENCE_SCOPE,
 *     CODEBASE_DETAIL — and those are questions about framing rather than
 *     subjects to omit, so they must land in `openQuestionSubjects`, never in
 *     the "NOT approved for use" list.
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

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
) {
	return {
		root: {
			kind: "QUESTION",
			status: "RESOLVED",
			decisionKind,
			subject,
			summary: null,
		},
		replies: [{ authorType: "USER", content: answer }],
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
			/Open questions that constrain this content type/,
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
			"## Open questions that constrain this content type",
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
			"## Open questions that constrain this content type",
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
			"## Open questions that constrain this content type",
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
