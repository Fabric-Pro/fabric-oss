import { join } from "node:path";
import {
	effectivePlanningAnalysis,
	renderAnalysisProse,
} from "@repo/utils/publishing-analysis-prose";
import { ASSET_RESTRICTING_KINDS } from "@repo/utils/publishing-asset-clamp";
import {
	BaseNewsletterBlurbSchema,
	PublishingNewsletterBlurbSchema,
} from "@repo/utils/publishing-newsletter-blurb-body";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseValueImports } from "../../publishing-shared/__tests__/_ast-guards";

/**
 * The Newsletter Blurb LLM activity (Fizzy #1988, Phase 2D slice 2D-2).
 *
 * The family's established guards are pinned by its siblings; what this file
 * exists for is the four things this type does DIFFERENTLY, each of which a
 * copy of `generate-webinar-script.ts` gets wrong by default:
 *
 *  1. THE RESTRICTION SPLIT runs on this type's OWN set, which is the
 *     Stakeholder Email's PAIR — `AUDIENCE_SCOPE` and `CLAIM_STRENGTH` — and
 *     NOT the Webinar Script's three. `CODEBASE_DETAIL` is deliberately absent,
 *     so an open thread of that kind must reach NEITHER block. That single case
 *     is what distinguishes `restrictsPostType(thread, "NEWSLETTER_BLURB")`
 *     from the post-type string the file was copied from, and nothing else in
 *     this suite can.
 *  2. THE PARSED DOCUMENT IS WHAT IS PERSISTED, not the model's raw object.
 *     This schema is a `.transform()` — it reconciles `ctaState` against the
 *     call to action actually written and normalizes a blank `suggestedCta` /
 *     `safetyNote` to null — so an activity that spread `result.object` would
 *     store a document contradicting its own content and pass every
 *     shape-level assertion while doing it.
 *  3. THE PROMPT'S VOCABULARY AND THE SCHEMA'S ENUMS ARE THE SAME LIST. The
 *     locked clauses enumerate the audience and release-status values in prose;
 *     `generateObject` validates against the enum. A value the clause offers
 *     that the enum rejects makes a COMPLIANT model answer unparseable, and the
 *     failure surfaces as a non-retryable schema error blaming the model.
 *  4. `generation.revisionVersion` / `generation.aiVersion` come from the ONE
 *     `getEffectivePlanningAnalysis` call that built the prompt context, and
 *     `sourceAnalysisVersion` is NOT persisted — it is the editor's optimistic
 *     concurrency token, not the identity of anything (spec §5.6).
 *
 * `@repo/utils/publishing-restrictions`, `@repo/utils/publishing-asset-clamp`
 * and `@repo/utils/publishing-newsletter-blurb-body` are deliberately NOT
 * mocked, and neither is the prompt builder. The whole question in (1), (2) and
 * (3) is which REAL predicate, algorithm and schema routes which real input; a
 * stub would encode this file's guess about that instead of measuring it.
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
const logDraftRefusal = vi.fn();
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		// The REAL implementation, not a hand-rolled stand-in — a second copy
		// here would encode this file's guess of the override semantics
		// instead of measuring them, and the empty-override case is exactly
		// where a guess goes wrong.
		effectiveContributorUserIds: actual.effectiveContributorUserIds,
		logDraftRefusal: (...a: unknown[]) => logDraftRefusal(...a),
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

const { logger } = vi.hoisted(() => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/logs", () => ({ logger }));

const collectPlanningContext = vi.fn();
vi.mock("../../publishing-planning/collect-planning-context", () => ({
	collectPlanningContext: (...a: unknown[]) => collectPlanningContext(...a),
}));

import { generateNewsletterBlurbActivity } from "../generate-newsletter-blurb";

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
	headline: "Builds now start warm",
	blurb: "Incremental caching turns a cold build into a warm one, so a merge no longer waits on a full rebuild.",
	ctaState: "PRESENT",
	suggestedCta: "Try the cache on your own pipeline this week.",
	audience: "CUSTOMER",
	releaseStatus: "SHIPPED",
	suggestedAssets: {
		confirmed: [],
		needsConfirmation: ["customer logo"],
	},
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
	generateNewsletterBlurbActivity({
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
/** The prompt string `generateObject` was actually sent. */
const sentPrompt = () => generateObject.mock.calls[0]?.[0]?.prompt as string;
/** The body `seedWorkingDraftIfAbsent` was asked to write. */
const seededBody = () =>
	seedWorkingDraftIfAbsent.mock.calls[0]?.[0]?.body as string;

describe("generateNewsletterBlurbActivity — tenancy and actor revalidation", () => {
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
		// Spec §7 step 2 before step 3: the tenancy read decides first, so a
		// topic from another project never reaches the authorization query at
		// all. Swapping the two would leave the throw and the model assertion
		// above green.
		expect(checkPublishingGenerationActor).not.toHaveBeenCalled();
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

	it("re-checks the actor exactly once on the happy path", async () => {
		// The positive control for every "…not called" assertion above: they
		// would all stay green if the activity never asked at all, and this is
		// the case that says it does. Named for what it asserts — the CALL, not
		// the `activity` string, which `assertGenerationActorAuthorized` keeps
		// for its own log line and never forwards to this query.
		await run();

		expect(checkPublishingGenerationActor).toHaveBeenCalledTimes(1);
	});
});

describe("generateNewsletterBlurbActivity — prompt resolution", () => {
	it("passes a null organization through to prompt resolution", async () => {
		// `organizationId ?? undefined` is load-bearing in
		// `getBoundPromptForAgent`: falsy takes the USER → SYSTEM path and
		// truthy the ORG → SYSTEM one, and the two never cross.
		await run({ organizationId: null });

		expect(getBoundPromptForAgent.mock.calls[0]?.[0]?.organizationId).toBe(
			undefined,
		);
	});

	it("resolves the newsletter blurb's own bound prompt", async () => {
		// The agent key is this type's own. A copied one resolves a binding
		// that renders a DIFFERENT content type's body and reports BOUND while
		// doing it — the failure this assertion exists for.
		await run();

		expect(getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "publishing_topic_newsletter_blurb",
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
			expect.objectContaining({ jobType: "publishing-newsletter-blurb" }),
		);
	});

	it("records DEFAULT_UNBOUND when no binding resolves", async () => {
		// Spec §5.6 by name. §6.3 step 7 makes an unseeded prompt a live
		// possibility, and this is the ONLY per-draft signal separating "the
		// feature works" from "the feature works and the organization's prompt
		// was never consulted" — a draft written from the default body reads
		// exactly like one written from a bound prompt.
		await run();

		expect(getBoundPromptForAgent).toHaveBeenCalledTimes(1);
		expect(persistedDraft().promptSource).toBe("DEFAULT_UNBOUND");
		expect(persistedContent().generation.promptSource).toBe(
			"DEFAULT_UNBOUND",
		);
		expect(persistedDraft().promptId).toBeNull();
		expect(persistedDraft().promptVersion).toBeNull();
	});

	it("records DEFAULT_RENDER_FAILED when a BOUND body renders to nothing", async () => {
		// A bound prompt exists — so this is not the DEFAULT_UNBOUND branch —
		// and its body renders blank, so the builder recovers onto the default.
		getBoundPromptForAgent.mockResolvedValue({
			id: "p-1",
			format: "HANDLEBARS",
			version: { content: "   ", version: 3 },
		});

		await run();

		expect(persistedDraft().promptSource).toBe("DEFAULT_RENDER_FAILED");
		expect(persistedDraft().promptId).toBe("p-1");
		expect(persistedDraft().promptVersion).toBe(3);
	});

	it("records BOUND and uses the bound body", async () => {
		getBoundPromptForAgent.mockResolvedValue({
			id: "p-1",
			format: "HANDLEBARS",
			version: { content: "Write up {{{topic_title}}}.", version: 2 },
		});

		await run();

		expect(persistedDraft().promptSource).toBe("BOUND");
		expect(sentPrompt()).toContain("Write up Faster incremental builds.");
	});

	it("appends the project's function-tag clause", async () => {
		getProjectFunctionTagClause.mockResolvedValue(
			"ROLE COMPOSITION: backend",
		);

		await run();

		expect(sentPrompt()).toContain("ROLE COMPOSITION: backend");
	});

	it("builds the prompt from the contributor override, not the AI list", async () => {
		// `effectiveContributorUserIds` is the ONLY thing that may decide who
		// the prompt calls a contributor.
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
		expect(sentPrompt()).toContain("Chosen Contributor");
	});
});

describe("generateNewsletterBlurbActivity — the restriction split", () => {
	it("routes a shared safety-critical kind into the NOT-approved block", async () => {
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "example-org"),
		]);

		await run();

		const prompt = sentPrompt();
		const restricted = prompt.slice(
			prompt.indexOf("## Unresolved approvals for this topic"),
		);
		expect(restricted).toContain("example-org");
		expect(prompt).not.toMatch(
			/Open questions that constrain this content type/,
		);
	});

	it("routes AUDIENCE_SCOPE and CLAIM_STRENGTH into the open-questions block", async () => {
		// `isRestrictingThread` returns FALSE for both — neither constrains
		// every content type. Only `restrictsPostType(thread,
		// "NEWSLETTER_BLURB")` sees them, so this case is what proves the
		// activity calls the per-type predicate rather than the shared one.
		listTopicDecisions.mockResolvedValue([
			openQuestion("AUDIENCE_SCOPE", "who this newsletter is for"),
			openQuestion("CLAIM_STRENGTH", "the latency result"),
		]);

		await run();

		const prompt = sentPrompt();
		const openHeading = prompt.indexOf(
			"## Open questions that constrain this content type",
		);
		expect(openHeading).toBeGreaterThan(-1);
		expect(prompt.slice(openHeading)).toContain(
			"who this newsletter is for",
		);
		expect(prompt.slice(openHeading)).toContain("the latency result");
		expect(prompt).not.toMatch(/Unresolved approvals for this topic/);
		expect(persistedContent().generation.openQuestionSubjects).toEqual([
			"who this newsletter is for",
			"the latency result",
		]);
		expect(persistedContent().generation.restrictedSubjects).toEqual([]);
	});

	it("ignores an open CODEBASE_DETAIL thread entirely — it is not in this type's set", async () => {
		// THE case that distinguishes this type from the file it is copied
		// from. `CODEBASE_DETAIL` is in the Case Study's and the Webinar
		// Script's extra sets and in NEITHER the shared set nor this type's, so
		// for a newsletter blurb it must reach neither block: a blurb has no
		// implementation-depth dial to turn, and a warning that fires where it
		// does not apply is how a reader learns to skim past the two that do.
		//
		// Left as `"WEBINAR_SCRIPT"` by a copy, this subject lands in
		// `openQuestionSubjects` and every assertion below goes red.
		listTopicDecisions.mockResolvedValue([
			openQuestion("CODEBASE_DETAIL", "how much of the resolver to show"),
		]);

		await run();

		const prompt = sentPrompt();
		expect(prompt).not.toMatch(
			/Open questions that constrain this content type/,
		);
		expect(prompt).not.toMatch(/Unresolved approvals for this topic/);
		expect(prompt).not.toContain("how much of the resolver to show");
		expect(persistedContent().generation.openQuestionSubjects).toEqual([]);
		expect(persistedContent().generation.restrictedSubjects).toEqual([]);
	});

	it("keeps CODEBASE_DETAIL out even while this type's own kinds are in", async () => {
		// The paired direction: the open-questions block EXISTS on this run, so
		// the assertion above cannot be passing merely because nothing was
		// routed anywhere.
		listTopicDecisions.mockResolvedValue([
			openQuestion("AUDIENCE_SCOPE", "who this newsletter is for"),
			openQuestion("CODEBASE_DETAIL", "how much of the resolver to show"),
		]);

		await run();

		const openHeading = sentPrompt().indexOf(
			"## Open questions that constrain this content type",
		);
		expect(openHeading).toBeGreaterThan(-1);
		expect(persistedContent().generation.openQuestionSubjects).toEqual([
			"who this newsletter is for",
		]);
	});

	it("keeps an AUDIENCE_SCOPE thread out of the NOT-approved block", async () => {
		// Putting it there would instruct the model to strip the audience
		// framing — on the format most likely to be pasted into a template and
		// sent to a list, the opposite of caution.
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "example-org"),
			openQuestion("AUDIENCE_SCOPE", "who this is written for"),
		]);

		await run();

		const prompt = sentPrompt();
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
			openQuestion("CLAIM_STRENGTH", "how strong the result is"),
		]);

		await run();

		const generation = persistedContent().generation;
		expect(generation.restrictedSubjects).toEqual([
			{ kind: "METRICS_APPROVAL", label: "the adoption number" },
		]);
		expect(generation.openQuestionSubjects).toEqual([
			"how strong the result is",
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

		const prompt = sentPrompt();
		expect(prompt).not.toMatch(/Unresolved approvals for this topic/);
		expect(prompt).toContain("Yes, we may name them.");
		expect(persistedContent().generation.restrictedSubjects).toEqual([]);
	});

	it("scopes the decision read by BOTH ids", async () => {
		await run();

		expect(listTopicDecisions).toHaveBeenCalledWith({
			topicId: "topic-1",
			projectId: "proj-1",
		});
	});
});

describe("generateNewsletterBlurbActivity — the model call", () => {
	it("validates against the TRANSFORMED schema, which is what the model's JSON schema is built from", async () => {
		await run();

		expect(generateObject.mock.calls[0]?.[0]?.schema).toBe(
			PublishingNewsletterBlurbSchema,
		);
	});

	it("disables strict JSON schema", async () => {
		// Azure/OpenAI reject a strict JSON schema containing optional fields
		// outright (bug #1681), and this schema has several.
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
		// Measured on what is actually SENT, role clause included: the clamp
		// exists to reserve context-window room for the input.
		getProjectFunctionTagClause.mockResolvedValue(
			"ROLE COMPOSITION: backend",
		);

		await run();

		expect(computeMaxOutputTokenBudget).toHaveBeenCalledWith(
			expect.anything(),
			{ promptChars: sentPrompt().length },
		);
		expect(generateObject.mock.calls[0]?.[0]?.maxOutputTokens).toBe(8192);
	});

	it("omits maxOutputTokens entirely when the helper declines to set one", async () => {
		// `undefined` is a real answer — some providers must not be sent an
		// explicit budget — so the field is spread in, never set to undefined.
		computeMaxOutputTokenBudget.mockReturnValue(undefined);

		await run();

		expect(generateObject.mock.calls[0]?.[0]).not.toHaveProperty(
			"maxOutputTokens",
		);
	});
});

describe("generateNewsletterBlurbActivity — the prompt and the schema agree", () => {
	/**
	 * The enumerated list a locked clause offers the model, read off the prompt
	 * `generateObject` was actually sent.
	 *
	 * Sliced rather than searched whole: every one of these values occurs a
	 * SECOND time in the sentence that follows its list ("On UNSPECIFIED,
	 * frame…", "UNCONFIRMED IS NOT A QUIETER WAY OF SAYING UPCOMING"), so a
	 * whole-prompt search would stay green with a value deleted from the list
	 * the model must actually choose from.
	 */
	function offeredValues(after: string, before: string): string[] {
		const prompt = sentPrompt();
		const start = prompt.indexOf(after);
		expect(start).toBeGreaterThan(-1);
		const end = prompt.indexOf(before, start + after.length);
		expect(end).toBeGreaterThan(start);
		return [
			...new Set(
				prompt
					.slice(start + after.length, end)
					.split(/[^A-Z_]+/)
					.filter((token) => /^[A-Z][A-Z_]{2,}$/.test(token)),
			),
		].sort();
	}

	it("offers exactly the six audience values the schema accepts", async () => {
		// Both directions, against the REAL enum rather than a second
		// hand-written list. A value the clause offers that the enum rejects
		// makes a COMPLIANT model answer unparseable, and it surfaces as a
		// non-retryable schema failure blaming the model for obeying.
		await run();

		expect(
			offeredValues(
				"the six values the schema defines: ",
				"On UNSPECIFIED, frame",
			),
		).toEqual(
			[
				...BaseNewsletterBlurbSchema.shape.audience.unwrap().options,
			].sort(),
		);
	});

	it("offers exactly the seven release-status values the schema accepts", async () => {
		await run();

		expect(
			offeredValues(
				"the seven values the schema defines: ",
				"UNCONFIRMED IS NOT",
			),
		).toEqual(
			[
				...BaseNewsletterBlurbSchema.shape.releaseStatus.unwrap()
					.options,
			].sort(),
		);
	});
});

describe("generateNewsletterBlurbActivity — the asset clamp", () => {
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
		expect(persistedContent().generation.clamped.assetKinds).toEqual({
			"admin console screenshot": "INTERNAL_UI",
			"product walkthrough video": "VIDEO_WALKTHROUGH",
		});
	});

	it("keeps every assetKinds key in assets and every value in ASSET_RESTRICTING_KINDS", async () => {
		// Spec §5.4's invariant, stated so it can be asserted rather than
		// merely believed. Run on a draft that ACTUALLY clamped and with the
		// map's size asserted first: on a clean run `assetKinds` is absent and
		// a loop over its entries would never execute, which is the shape of
		// assertion that cannot fail.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				suggestedAssets: {
					confirmed: ["admin console screenshot", "latency chart"],
					needsConfirmation: [],
				},
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("INTERNAL_UI", "admin console screenshot"),
			openQuestion("ASSET_APPROVAL", "latency chart"),
		]);

		await run();

		const { assets, assetKinds } = persistedContent().generation.clamped;
		expect(assets).toHaveLength(2);
		expect(Object.keys(assetKinds)).toHaveLength(2);
		for (const [label, kind] of Object.entries(assetKinds)) {
			expect(assets).toContain(label);
			expect(ASSET_RESTRICTING_KINDS.has(kind as string)).toBe(true);
		}
	});

	it("resolves an asset matching TWO restricting kinds to the first in iteration order", async () => {
		// Iteration order of `ASSET_RESTRICTING_KINDS` is ASSET_APPROVAL,
		// INTERNAL_UI, VIDEO_WALKTHROUGH — so an asset named by both an open
		// ASSET_APPROVAL and an open INTERNAL_UI thread is attributed to
		// ASSET_APPROVAL, whichever order the threads arrive in.
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

	it("never upgrades: an asset the model itself hedged stays hedged", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				suggestedAssets: {
					confirmed: [],
					needsConfirmation: ["customer logo"],
				},
			},
			usage: {},
		});

		await run();

		expect(persistedContent().suggestedAssets.confirmed).toEqual([]);
		expect(persistedContent().suggestedAssets.needsConfirmation).toEqual([
			"customer logo",
		]);
		expect(persistedContent().generation.clamped).toEqual({});
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
		// A framing question (CLAIM_STRENGTH here) is not a claim about whether
		// an asset exists and may be used.
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
			openQuestion("CLAIM_STRENGTH", "architecture diagram"),
			openQuestion("AUDIENCE_SCOPE", "architecture diagram"),
		]);

		await run();

		expect(persistedContent().suggestedAssets.confirmed).toEqual([
			"architecture diagram",
		]);
		expect(persistedContent().generation.clamped).toEqual({});
	});

	it("stays absent (never []) on the clean run — an empty array would fire the log gate", async () => {
		await run();

		expect(persistedContent().generation.clamped).toEqual({});
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

describe("generateNewsletterBlurbActivity — what it persists", () => {
	it("imports ONLY the reads and the two writes the guarantee allows", () => {
		// The card's guarantee: generating a blurb publishes nothing, sends
		// nothing, creates no asset and mutates no tag.
		expect(
			databaseValueImports(
				join(__dirname, "../generate-newsletter-blurb.ts"),
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

	it("persists the PARSED document, so ctaState is reconciled against the CTA actually written", async () => {
		// The schema is a `.transform()`. A model that writes the call to
		// action and leaves the state at its default is the single likeliest
		// output this type produces — `ctaState` has no section in the PO
		// prompt while the skeleton actively asks for a CTA string — and an
		// activity that spread `result.object` would store `UNKNOWN` beside a
		// real call to action, then compose a working draft that drops it.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				ctaState: "UNKNOWN",
				suggestedCta: "Reply to this email to join the pilot.",
			},
			usage: {},
		});

		await run();

		expect(persistedContent().ctaState).toBe("PRESENT");
		expect(seededBody()).toContain("## Suggested call to action");
		expect(seededBody()).toContain(
			"Reply to this email to join the pilot.",
		);
	});

	it("persists the parsed document's normalized safety note", async () => {
		// Same property from the other side: a blank note arrives as null, not
		// as whitespace a downstream reader has to re-trim.
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, safetyNote: "   " },
			usage: {},
		});

		await run();

		expect(persistedContent().safetyNote).toBeNull();
	});

	it("carries the run's guidance onto the stored draft", async () => {
		await run({ guidance: "Aim it at the customer list." });

		expect(persistedContent().generation.guidance).toBe(
			"Aim it at the customer list.",
		);
	});

	it("feeds a non-null currentDraft to the prompt builder and records the refinement flag", async () => {
		await run({
			currentDraft: "REFINE-CANARY: the saved working blurb.",
		});

		expect(persistedContent().generation.refinedFromWorkingDraft).toBe(
			true,
		);
		expect(sentPrompt()).toContain(
			"REFINE-CANARY: the saved working blurb.",
		);
	});

	it("records refinedFromWorkingDraft false on an ordinary generation", async () => {
		await run();

		expect(persistedContent().generation.refinedFromWorkingDraft).toBe(
			false,
		);
	});

	it("records whether the bound prompt's format was overridden", async () => {
		// MARKDOWN does no templating at all and `renderTemplate` reports NO
		// error, so without the override the model receives a body with zero
		// topic data in it and writes a plausible blurb about nothing.
		getBoundPromptForAgent.mockResolvedValue({
			id: "p-1",
			format: "MARKDOWN",
			version: { content: "Write up {{{topic_title}}}.", version: 4 },
		});

		await run();

		expect(persistedContent().generation.formatOverridden).toBe(true);
	});

	it("persists the analysis versions it actually read, from ONE call", async () => {
		// `revisionVersion` identifies the PROSE half and `aiVersion` the
		// structured DATA half: the effective analysis composes them from
		// different rows, so one alone would not say which analysis produced
		// this draft. A second call — or a revision landing between two — would
		// record a version the draft was not written from.
		getEffectivePlanningAnalysis.mockResolvedValue({
			effective: null,
			aiVersion: 7,
			revisionVersion: 3,
			sourceAnalysisVersion: 5,
			author: null,
			revisionCreatedAt: null,
		});

		await run();

		expect(getEffectivePlanningAnalysis).toHaveBeenCalledTimes(1);
		expect(getEffectivePlanningAnalysis).toHaveBeenCalledWith({
			topicId: "topic-1",
			projectId: "proj-1",
		});
		expect(persistedContent().generation).toMatchObject({
			revisionVersion: 3,
			aiVersion: 7,
		});
	});

	it("does NOT persist sourceAnalysisVersion", async () => {
		// Its own comment calls it "What the NEXT save must send": it is the
		// editor's optimistic concurrency token, not the identity of anything,
		// and a forensic field that looks authoritative and is not is worse
		// than no field. The fixture gives it a value distinct from both
		// versions above, so a copy-through would be visible.
		getEffectivePlanningAnalysis.mockResolvedValue({
			effective: null,
			aiVersion: 7,
			revisionVersion: 3,
			sourceAnalysisVersion: 5,
			author: null,
			revisionCreatedAt: null,
		});

		await run();

		expect(persistedContent().generation).not.toHaveProperty(
			"sourceAnalysisVersion",
		);
	});

	it("persists null analysis versions when the topic has never been analysed", async () => {
		await run();

		expect(persistedContent().generation).toMatchObject({
			revisionVersion: null,
			aiVersion: null,
		});
	});

	it("stamps generatedAt", async () => {
		await run();

		expect(
			Number.isNaN(Date.parse(persistedContent().generation.generatedAt)),
		).toBe(false);
	});
});

describe("generateNewsletterBlurbActivity — the write surface", () => {
	it("seeds a body that starts with the composed headline", async () => {
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, headline: "NB-SEED-CANARY headline" },
			usage: {},
		});

		await run();

		expect(seedWorkingDraftIfAbsent).toHaveBeenCalledTimes(1);
		expect(seedWorkingDraftIfAbsent).toHaveBeenCalledWith(
			expect.objectContaining({
				topicId: "topic-1",
				projectId: "proj-1",
				postType: "NEWSLETTER_BLURB",
				sourceDraftId: "draft-1",
				updatedById: "user-1",
				body: expect.stringContaining("# NB-SEED-CANARY headline"),
			}),
		);
	});

	it("omits the call-to-action section the composer omits, rather than emitting a bare heading", async () => {
		// The property that separates the SHARED composer from an inline
		// compose that merely happens to start with the headline: an OMITTED
		// call to action is a decision with no text to carry, so the section
		// must not appear at all.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				ctaState: "OMITTED",
				suggestedCta: null,
			},
			usage: {},
		});

		await run();

		expect(seededBody()).toContain("# Builds now start warm");
		expect(seededBody()).not.toContain("Suggested call to action");
	});

	it("writes nothing at all when the output fails schema validation", async () => {
		generateObject.mockResolvedValue({
			object: { headline: "A headline" },
			usage: {},
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_NEWSLETTER_BLURB_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completeTopicDraft).not.toHaveBeenCalled();
		expect(seedWorkingDraftIfAbsent).not.toHaveBeenCalled();
	});

	it("rejects a whitespace-only headline instead of seeding a headless draft", async () => {
		// `.trim()` before `.min(1)`: the weak form makes the run SUCCEED, seed
		// a working draft with an empty heading, and then every downstream
		// reader narrows the stored document to null.
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, headline: "   " },
			usage: {},
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_NEWSLETTER_BLURB_SCHEMA_VALIDATION_FAILED",
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

	it("reports the refusal reason the writer gave, not a guess", async () => {
		completeTopicDraft.mockResolvedValue({
			persisted: false,
			reason: "project_ineligible",
		});

		await expect(run()).resolves.toEqual({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
			refusalReason: "project_ineligible",
		});
		// The reason, not the guess: the incident this guards against had all
		// three refusals logging "superseded" regardless of what actually
		// happened.
		expect(logDraftRefusal).toHaveBeenCalledWith(
			expect.stringContaining("publishing-newsletter-blurb"),
			"project_ineligible",
			{ draftId: "draft-1", topicId: "topic-1", projectId: "proj-1" },
		);
	});

	it("reports no seeding when the topic already has a draft", async () => {
		seedWorkingDraftIfAbsent.mockResolvedValue({
			status: "already_exists",
		});

		await expect(run()).resolves.toEqual({
			status: "READY",
			seededWorkingDraft: false,
		});
	});

	it("still reports READY when the project became ineligible before seeding", async () => {
		// The draft is committed. This is not a failed generation — it is a
		// topic nobody can act on any more.
		seedWorkingDraftIfAbsent.mockResolvedValue({
			status: "project_ineligible",
		});

		await expect(run()).resolves.toEqual({
			status: "READY",
			seededWorkingDraft: false,
		});
	});

	it("still reports READY when a newer attempt overtook the seed", async () => {
		// Same shape as SUPERSEDED, arriving one write later: the draft this
		// run just committed is no longer the READY row for this content
		// type by the time the seed attempt runs.
		seedWorkingDraftIfAbsent.mockResolvedValue({
			status: "source_not_found",
		});

		await expect(run()).resolves.toEqual({
			status: "READY",
			seededWorkingDraft: false,
		});
		// The branch's ONLY distinct effect: it is the expected outcome of a
		// race, not a fault, so it must not log at the level its
		// project_ineligible sibling uses.
		expect(logger.info).toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("generateNewsletterBlurbActivity — the effective analysis reaches the prompt", () => {
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

		expect(sentPrompt()).toContain("USER PROSE");
		expect(sentPrompt()).not.toContain("AI ANGLE");
		// A second inline query is how the editable document silently stops
		// reaching the model (Fizzy #1851).
		expect(analysisFindFirst).not.toHaveBeenCalled();
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

		expect(sentPrompt()).toContain("AI ANGLE");
		expect(sentPrompt()).toContain(renderAnalysisProse(AI));
	});
});
