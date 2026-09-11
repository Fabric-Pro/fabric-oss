/**
 * Newsletter Blurb — the LLM activity (Publishing Suite Phase 2D slice 2D-2,
 * Fizzy #1988).
 *
 * One model call, wrapped in the same guards its Case Study, Stakeholder Email,
 * Blog Post, Short Post, Webinar Script and Planning & Analysis siblings
 * established. The order below is copied unchanged, because each step's
 * POSITION is what it is for (spec §7):
 *
 *  1. The topic is read re-scoped by `projectId`. A topic id is a client input
 *     everywhere it appears, and a valid id from another project must resolve
 *     to the same nothing a deleted one does (DV16).
 *  2. The actor's authorization is re-checked at the point of use, before any
 *     model is resolved — the SAME question the API gate asked, which is a
 *     project permission and NOT org membership (only the last of that gate's
 *     three paths). Provider resolution is organization-first, so a revoked
 *     collaborator would otherwise keep spending the organization's key and
 *     credits on its material. Fail-closed via a non-retryable throw.
 *  3. Output is `safeParse`d before anything is written.
 *
 * The bound prompt is resolved HERE, in the activity, never in the workflow —
 * activity bodies are not replayed, so this adds no command to the workflow's
 * sequence and cannot cause TMPRL1100.
 *
 * THE RESTRICTION PASS SPLITS, exactly as its siblings' do, but on THIS type's
 * set. `restrictsPostType(thread, "NEWSLETTER_BLURB")` matches the Stakeholder
 * Email's PAIR — `AUDIENCE_SCOPE` and `CLAIM_STRENGTH` — and not the Webinar
 * Script's three: `CODEBASE_DETAIL` is deliberately absent, because a blurb has
 * no implementation-depth dial to turn and the disclosure rule in the locked
 * clauses covers the residue. Those two kinds are questions about how the item
 * is FRAMED rather than subjects to omit, so they go into a second list with
 * its own locked-clause wording. See `buildNewsletterBlurbLockedClauses`.
 *
 * THE ASSET CLAMP, shared rather than reimplemented
 * (`@repo/utils/publishing-asset-clamp`). `suggestedAssets.confirmed` is a model
 * SELF-CLAIM that an asset exists and is safe to use, and this is the format
 * most likely to be pasted into a template and sent to a list without a second
 * read — so an asset an open approval thread is about is moved to
 * needs-confirmation server-side. Like the Webinar Script and unlike the Case
 * Study, this schema carries no `customerIdentity` / `metricsBasis`-shaped enum,
 * so the clamp below is the asset half only.
 *
 * `generation.revisionVersion` and `generation.aiVersion` are persisted (spec
 * §5.6, DV5). Both are destructured from the SAME `getEffectivePlanningAnalysis`
 * call that built the prompt context, never a second read: `revisionVersion`
 * identifies the PROSE half of the effective analysis and `aiVersion` the
 * structured DATA half, because `effectivePlanningAnalysis` composes them from
 * different rows and a hybrid document has no single version of its own.
 * `sourceAnalysisVersion` is deliberately NOT persisted — its own comment calls
 * it "What the NEXT save must send", which makes it the editor's optimistic
 * concurrency token rather than the identity of anything, and a forensic field
 * that looks authoritative and is not is worse than no field at all.
 *
 * Like its siblings, after the draft commits it seeds the topic's working draft
 * if the topic has none (DV5/FR21). The seeding call is CREATE-ONLY by
 * construction, so a regeneration cannot reach an existing draft and FR35 holds
 * without a condition here having to be right.
 */

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	completeTopicDraft,
	type DraftCommitRefusal,
	db,
	effectiveContributorUserIds,
	getBoundPromptForAgent,
	getEffectivePlanningAnalysis,
	listTopicDecisions,
	logDraftRefusal,
	seedWorkingDraftIfAbsent,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { TemplateFormat } from "@repo/utils";
import {
	clampConfirmedAssets,
	type PublishingClampRecord,
} from "@repo/utils/publishing-asset-clamp";
import {
	composeNewsletterBlurbWorkingDraftBody,
	PublishingNewsletterBlurbSchema,
} from "@repo/utils/publishing-newsletter-blurb-body";
import {
	isRestrictingThread,
	restrictionLabel,
	restrictsPostType,
} from "@repo/utils/publishing-restrictions";
import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { collectPlanningContext } from "../publishing-planning/collect-planning-context";
import {
	assertGenerationActorAuthorized,
	resolveContributorNames,
} from "../publishing-shared";
import {
	buildNewsletterBlurbPrompt,
	type NewsletterBlurbDecision,
	PUBLISHING_NEWSLETTER_BLURB_AGENT_KEY,
	PUBLISHING_NEWSLETTER_BLURB_FALLBACK_BODY,
} from "./build-newsletter-blurb-prompt";

export interface GenerateNewsletterBlurbInput {
	/** The GENERATING row this run owns. */
	draftId: string;
	topicId: string;
	projectId: string;
	organizationId: string | null;
	/** Who pressed the button — the identity the model is resolved under. */
	actorUserId: string;
	/** The guidance recorded on the attempt row, or null. */
	guidance: string | null;
	/**
	 * The topic's saved working blurb when this run REFINES it, read by the
	 * procedure from the server's own store and clamped there.
	 *
	 * OPTIONAL on purpose. A Temporal history recorded before this field existed
	 * replays with it absent, and absent must mean "an ordinary generation" —
	 * which is exactly what null does here.
	 */
	currentDraft?: string | null;
}

export interface GenerateNewsletterBlurbOutput {
	/**
	 * `SUPERSEDED` is not an error. It means a deadline sweep reclaimed this
	 * attempt while the model was running and a newer one now owns the content
	 * type, so the compare-and-set refused the write. The workflow must NOT mark
	 * the row failed on this path — the row is already terminal, and the newer
	 * attempt is the one a reader should see.
	 */
	status: "READY" | "SUPERSEDED";
	/**
	 * Which refusal produced a non-READY status.
	 *
	 * OPTIONAL on purpose. A Temporal history recorded before this field
	 * existed replays without it, and a workflow that read it as required
	 * would fail that replay. Absent means "an older run that could not say".
	 */
	refusalReason?: DraftCommitRefusal;
	/**
	 * Whether this run created the topic's working draft.
	 *
	 * Returned rather than only logged because it is the observable difference
	 * between a first generation and a regeneration, and the panel's behaviour
	 * differs: a seeded run lands the reader in an editor, a later one offers an
	 * adopt control instead.
	 */
	seededWorkingDraft: boolean;
}

/** One restricting thread as the stored `generation` block records it. */
interface RestrictedSubjectRecord {
	kind: string;
	label: string;
}

export async function generateNewsletterBlurbActivity(
	input: GenerateNewsletterBlurbInput,
): Promise<GenerateNewsletterBlurbOutput> {
	const { draftId, topicId, projectId, organizationId, actorUserId } = input;

	heartbeat(`newsletterBlurb: ${draftId}`);

	// (1) Tenancy. Both ids, always — see the file header.
	const topic = await db.publishingTopic.findFirst({
		where: { id: topicId, projectId },
		select: {
			id: true,
			title: true,
			pitch: true,
			angle: true,
			subject: true,
			relevantFunctionTags: true,
			postTypeRecommendations: true,
			contributorUserIds: true,
			contributorsOverridden: true,
			userContributorUserIds: true,
			provenance: true,
		},
	});
	if (!topic) {
		throw ApplicationFailure.nonRetryable(
			"Topic does not exist in this project",
			"PUBLISHING_TENANT_MISMATCH",
		);
	}

	// (2) Point-of-use actor re-validation (TOCTOU). Before ANYTHING that
	// resolves a model or spends the organization's provider quota. Asks the
	// API gate's own question; see `assertGenerationActorAuthorized`.
	await assertGenerationActorAuthorized({
		projectId,
		organizationId,
		actorUserId,
		activity: "generateNewsletterBlurbActivity",
	});

	const [
		boundPrompt,
		contextResult,
		contributors,
		roleClause,
		threads,
		effectiveAnalysis,
	] = await Promise.all([
		// `organizationId ?? undefined` is load-bearing: falsy takes the
		// personal USER → SYSTEM path, truthy takes ORG → SYSTEM, and the two
		// never cross (getBoundPromptVersion, prompts.ts).
		getBoundPromptForAgent({
			agentName: PUBLISHING_NEWSLETTER_BLURB_AGENT_KEY,
			documentType: "GENERAL",
			storyKind: null,
			userId: actorUserId,
			organizationId: organizationId ?? undefined,
		}),
		collectPlanningContext({
			projectId,
			organizationId,
			userId: actorUserId,
			topicId,
			provenance: topic.provenance,
		}),
		resolveContributorNames(effectiveContributorUserIds(topic)),
		getProjectFunctionTagClause({
			projectId,
			requesterUserId: actorUserId,
			surface: "publishing-suite",
		}),
		listTopicDecisions({ topicId, projectId }),
		// The topic's EFFECTIVE analysis: the author's edited prose when a
		// revision exists, otherwise the AI's own, plus the structured half
		// nobody edits. Resolved through the ONE reader rather than read off
		// the analysis row here — a second inline query is how the editable
		// document silently stops reaching the model (Fizzy #1851).
		//
		// Scoped by projectId like every other read here; absent is a NORMAL
		// answer, not a failure — UC3's precondition is "sufficient planning
		// context OR source context", so a topic nobody has analysed still
		// drafts from its raw sources. `revisionVersion` and `aiVersion` off
		// this SAME call are what the persisted `generation` block below
		// records — see the file header.
		getEffectivePlanningAnalysis({ topicId, projectId }),
	]);

	heartbeat(`newsletterBlurb: context assembled for ${draftId}`);

	// ANSWERED threads become instructions; OPEN restricting ones become
	// constraints. Two lists from one read, and both are derived here rather
	// than passed in, because the minutes between the button and this line are
	// exactly when someone answers a question.
	//
	// THE SPLIT. `restrictsPostType(thread, "NEWSLETTER_BLURB")` is a superset
	// of `isRestrictingThread`: the shared safety-critical kinds plus
	// AUDIENCE_SCOPE / CLAIM_STRENGTH. A thread that matches the shared
	// predicate is a SUBJECT the draft must write around; a thread that matches
	// only the per-type extra is a QUESTION about how the item is framed.
	// Routing them into one list would put "Audience scope" under "NOT approved
	// for use … leave it out", which tells the model to strip the audience
	// framing — the opposite of caution on a format that travels further than
	// its author expects.
	//
	// A kind in NEITHER set — CODEBASE_DETAIL is the live example, since it is
	// in the Case Study's and Webinar Script's extra sets and in neither the
	// shared set nor this one — falls through both branches and constrains
	// nothing here. That is the design, not an omission: see
	// `EXTRA_RESTRICTING_KINDS_BY_POST_TYPE`.
	const decisions: NewsletterBlurbDecision[] = [];
	const restricted: RestrictedSubjectRecord[] = [];
	const openQuestionSubjects: string[] = [];
	for (const thread of threads) {
		if (restrictsPostType(thread, "NEWSLETTER_BLURB")) {
			if (isRestrictingThread(thread)) {
				// Recorded as {kind, label}, not a bare string, so a stored
				// draft can say WHICH rule set was in force when it was
				// written. A later change to `SAFETY_CRITICAL_KINDS` would
				// otherwise silently reinterpret every draft already on disk.
				restricted.push({
					kind: thread.root.decisionKind ?? "OTHER",
					label: restrictionLabel(thread),
				});
			} else {
				openQuestionSubjects.push(restrictionLabel(thread));
			}
			continue;
		}
		if (thread.root.kind !== "QUESTION" || thread.root.status === "OPEN") {
			continue;
		}
		// The settled answer is the newest USER reply; the root's own summary is
		// the fallback for a question closed without one.
		const answer =
			[...thread.replies]
				.reverse()
				.find((r) => r.authorType === "USER" && r.content?.trim())
				?.content?.trim() ??
			thread.root.summary?.trim() ??
			"";
		if (answer) {
			decisions.push({
				subject: thread.root.subject,
				decisionKind: thread.root.decisionKind ?? "OTHER",
				answer,
			});
		}
	}

	const composed = await buildNewsletterBlurbPrompt({
		templateBody:
			boundPrompt?.version?.content ??
			PUBLISHING_NEWSLETTER_BLURB_FALLBACK_BODY,
		format:
			(boundPrompt?.format as TemplateFormat | undefined) ?? "HANDLEBARS",
		topic: {
			id: topic.id,
			title: topic.title,
			pitch: topic.pitch,
			angle: topic.angle,
			subject: topic.subject,
			relevantFunctionTags: topic.relevantFunctionTags as string[],
			postTypeRecommendations: topic.postTypeRecommendations,
			contributors,
		},
		context: contextResult.context,
		analysisProse: effectiveAnalysis.effective?.prose ?? "",
		analysisData: effectiveAnalysis.effective?.data ?? {},
		decisions,
		guidance: input.guidance,
		currentDraft: input.currentDraft ?? null,
		restrictedSubjects: restricted.map((r) => r.label),
		openQuestionSubjects,
	});

	const prompt = composed.prompt + (roleClause ? `\n\n${roleClause}` : "");

	// Which prompt actually shaped this draft. Persisted rather than only
	// logged: a blurb written from the default body because a bound prompt
	// would not render reads exactly like one written from the bound prompt —
	// and least of all on this type, whose output is short enough to look
	// already checked.
	const promptSource = !boundPrompt
		? ("DEFAULT_UNBOUND" as const)
		: composed.bodyRecovered
			? ("DEFAULT_RENDER_FAILED" as const)
			: ("BOUND" as const);

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: actorUserId,
			organizationId: organizationId ?? undefined,
			jobType: "publishing-newsletter-blurb",
		},
	);

	// Bound the generation. Without a budget an over-long response fails as a
	// HANG — it burns this activity's whole allowance and then reports a timeout,
	// which reads as a broken feature rather than a slow one. `promptChars` is
	// measured on what is actually SENT (role clause included), because the
	// clamp exists to reserve context-window room for the input.
	//
	// `undefined` is a real answer — some providers must not be sent an explicit
	// budget — so the field is spread in, never set to undefined.
	const maxOutputTokens = computeMaxOutputTokenBudget(metadata, {
		promptChars: prompt.length,
	});

	const beat = setInterval(() => heartbeat(), 10_000);
	let result: Awaited<ReturnType<typeof generateObject>>;
	try {
		result = await generateObject({
			model,
			schema: PublishingNewsletterBlurbSchema,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			// Azure/OpenAI reject a strict JSON schema containing optional fields
			// outright (bug #1681), and this schema has several. The AI SDK still
			// validates the object against the zod schema.
			providerOptions: { openai: { strictJsonSchema: false } },
		});
	} finally {
		clearInterval(beat);
	}

	trackUsage();

	// Fail closed. `generateObject` already validates, but it is not the only way
	// an object reaches this line.
	//
	// `parsed.data` — never `result.object` — is what gets written below. This
	// schema is a `.transform()`: it reconciles `ctaState` against the call to
	// action actually written and normalizes a blank `suggestedCta` or
	// `safetyNote` to null. Persisting the raw object would store a document
	// contradicting its own content, and the likeliest single miswrite this
	// type produces (a real CTA with the state left at its default) is exactly
	// the one that reconciliation fixes.
	const parsed = PublishingNewsletterBlurbSchema.safeParse(result.object);
	if (!parsed.success) {
		throw ApplicationFailure.nonRetryable(
			`Newsletter blurb failed schema validation: ${parsed.error.message}`,
			"PUBLISHING_NEWSLETTER_BLURB_SCHEMA_VALIDATION_FAILED",
		);
	}

	// -------------------------------------------------------------------------
	// THE CLAMP — assets only.
	// -------------------------------------------------------------------------
	//
	// This schema carries no `customerIdentity` / `metricsBasis`-shaped enum, so
	// unlike the case study there is nothing else to compare against an open
	// approval — see the file header. `suggestedAssets.confirmed` is the same
	// kind of model self-claim the case study's `confirmedAssets` is, and it
	// gets the same treatment, via the SAME shared algorithm
	// (`@repo/utils/publishing-asset-clamp`).
	//
	// Derived from the SAME `threads` array already in hand — deliberately not a
	// fresh query. The label has to describe THIS body, and this body was written
	// against that snapshot; re-reading would let a question answered during the
	// model call clear a draft that was written as though it were still open (or
	// flag one that was not).
	//
	// Restricted subjects only, not open questions: a framing question is not a
	// claim about whether an asset exists and may be used.
	const document = { ...parsed.data };
	const clamped: PublishingClampRecord = {};
	const assetClamp = clampConfirmedAssets({
		confirmed: document.suggestedAssets.confirmed,
		needsConfirmation: document.suggestedAssets.needsConfirmation,
		restricted,
	});
	if (assetClamp.moved.length > 0) {
		document.suggestedAssets = {
			confirmed: assetClamp.confirmed,
			needsConfirmation: assetClamp.needsConfirmation,
		};
		// PRE-dedupe, matching what the case study's call site has always
		// recorded, and assigned ONLY inside this branch: an unconditional
		// assignment would leave `clamped.assets = []` on every clean run, and
		// the log gate below treats an empty array as truthy — so the "clamped
		// a model claim" line would fire on generations that clamped nothing.
		//
		// `assetKinds` is the sibling map label -> the ASSET_RESTRICTING_KINDS
		// member that caused the move, persisted here as it is for the Webinar
		// Script because the panel renders that attribution (spec §5.4/§5.6).
		clamped.assets = assetClamp.moved.map((m) => m.label);
		clamped.assetKinds = Object.fromEntries(
			assetClamp.moved.map((m) => [m.label, m.kind]),
		);
	}

	if (clamped.assets) {
		logger.info(
			"[publishing-newsletter-blurb] clamped a model claim against an open approval",
			{ draftId, topicId, projectId, clamped },
		);
	}

	const content = {
		...document,
		generation: {
			promptSource,
			promptId: boundPrompt?.id ?? null,
			promptVersion: boundPrompt?.version?.version ?? null,
			// FORENSIC-ONLY, stated plainly so the next reader does not go
			// looking for the UI that shows them. NOTHING in this repo reads
			// these off a stored Newsletter Blurb draft: no procedure returns
			// them, no component renders them, no alert fires on them. They are
			// reachable only by querying the row.
			formatOverridden: composed.formatOverridden,
			restrictedSubjects: restricted,
			openQuestionSubjects,
			// Not forensic-only: the panel reads `assets` and `assetKinds` off
			// the stored draft to say "we moved this asset, and here is the
			// approval that did it" (spec §5.4/§5.6).
			clamped,
			guidance: input.guidance,
			// Whether this candidate is a REVISION of the saved working blurb
			// or a draft written from the planning analysis. Recorded because
			// the two are indistinguishable once written: nothing else on the
			// row says which question the model was asked, and `guidance` reads
			// the same either way.
			refinedFromWorkingDraft: Boolean(input.currentDraft?.trim()),
			// DV5 (spec §5.6). Both destructured from the SAME
			// `getEffectivePlanningAnalysis` call that built the prompt
			// context, above — never a second read. `revisionVersion`
			// identifies the prose half of the effective analysis and
			// `aiVersion` the structured data half; a hybrid document has no
			// single version of its own, and recording only one of the two
			// would let a later reader assume it named the whole input.
			// `sourceAnalysisVersion` is NOT recorded — see the file header.
			revisionVersion: effectiveAnalysis.revisionVersion,
			aiVersion: effectiveAnalysis.aiVersion,
			generatedAt: new Date().toISOString(),
		},
	};

	const commit = await completeTopicDraft({
		id: draftId,
		projectId,
		content,
		sourceRefs: contextResult.sourceRefs,
		model: metadata?.modelString ?? null,
		promptSource,
		promptId: boundPrompt?.id ?? null,
		promptVersion: boundPrompt?.version?.version ?? null,
	});

	if (!commit.persisted) {
		// The reason, not the guess. All three refusals used to log
		// "superseded", which sent an operator looking for a newer attempt
		// that in two of the three cases does not exist.
		logDraftRefusal(
			"[publishing-newsletter-blurb] draft not committed",
			commit.reason,
			{
				draftId,
				topicId,
				projectId,
			},
		);
		return {
			status: "SUPERSEDED",
			seededWorkingDraft: false,
			refusalReason: commit.reason,
		};
	}

	// DV5/FR21: the first generation leaves the reader with something editable.
	// Deliberately AFTER the draft commits and in its own transaction, not
	// folded into `completeTopicDraft` — that helper is shared with the short
	// post, which must not seed (DV4).
	//
	// `composeNewsletterBlurbWorkingDraftBody` comes from `@repo/utils` rather
	// than being composed here: `@repo/api` re-composes the same text when a
	// stored version is adopted, and the two must agree byte-for-byte.
	//
	// A crash between the two writes degrades rather than corrupts: the panel
	// shows a READY candidate with no working draft, which is the state a
	// regeneration produces anyway, and the adopt control resolves it.
	const seeded = await seedWorkingDraftIfAbsent({
		topicId,
		projectId,
		postType: "NEWSLETTER_BLURB",
		sourceDraftId: draftId,
		body: composeNewsletterBlurbWorkingDraftBody(document),
		updatedById: actorUserId,
	});

	if (seeded.status === "project_ineligible") {
		// The project was archived between the draft write and this one. The
		// draft is committed and READY, so this is not a failed generation —
		// it is a topic nobody can act on any more.
		logger.warn(
			"[publishing-newsletter-blurb] project became ineligible before the working draft could be seeded",
			{ draftId, topicId, projectId },
		);
	} else if (seeded.status === "source_not_found") {
		// The draft this run just committed is no longer the READY row for this
		// content type: a newer attempt overtook it in the gap. Same shape as
		// SUPERSEDED, arriving one write later.
		logger.info(
			"[publishing-newsletter-blurb] draft was superseded before it could seed a working draft",
			{ draftId, topicId, projectId },
		);
	} else if (seeded.status === "already_exists") {
		// The ordinary regeneration path, and the FR35 guarantee working as
		// designed. Debug, not warning: this is what most runs do.
		logger.debug(
			"[publishing-newsletter-blurb] topic already has a working draft; left untouched",
			{ draftId, topicId, projectId },
		);
	}

	return {
		status: "READY",
		seededWorkingDraft: seeded.status === "seeded",
	};
}
