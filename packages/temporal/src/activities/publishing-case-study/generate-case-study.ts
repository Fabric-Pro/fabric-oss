/**
 * Case Study — the LLM activity (Publishing Suite Phase 2C, #1854).
 *
 * One model call, wrapped in the same guards its Blog Post, Short Post and
 * Planning & Analysis siblings established. In order:
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
 * TWO THINGS THIS DOES THAT THE BLOG POST DOES NOT, both because the case study
 * is the most approval-sensitive type in the suite:
 *
 *  - The restriction pass SPLITS. `restrictsPostType(thread, "CASE_STUDY")`
 *    matches three kinds no other type restricts, and those are questions about
 *    framing rather than subjects to omit — so they go into a second list with
 *    its own locked-clause wording. See `buildCaseStudyLockedClauses`.
 *  - The output is CLAMPED against the same thread snapshot before it is
 *    written. See the clamp below.
 *
 * Like the blog post, after the draft commits it seeds the topic's working draft
 * if the topic has none (DV5/FR21). The seeding call is CREATE-ONLY by
 * construction, so a regeneration cannot reach an existing draft and FR35 holds
 * without a condition here having to be right.
 */

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	completeTopicDraft,
	db,
	getBoundPromptForAgent,
	listTopicDecisions,
	seedWorkingDraftIfAbsent,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { TemplateFormat } from "@repo/utils";
import { composeCaseStudyWorkingDraftBody } from "@repo/utils/publishing-case-study-body";
import {
	ASSET_RESTRICTING_KINDS,
	assetIsRestricted,
	CASE_STUDY_CLAMP_REASON,
	type CaseStudyClampRecord,
} from "@repo/utils/publishing-case-study-clamp";
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
	type CaseStudyDecision,
	composeCaseStudyPrompt,
	PUBLISHING_CASE_STUDY_AGENT_KEY,
	PUBLISHING_CASE_STUDY_FALLBACK_BODY,
	PublishingCaseStudySchema,
} from "./build-case-study-prompt";

export interface GenerateCaseStudyInput {
	/** The GENERATING row this run owns. */
	draftId: string;
	topicId: string;
	projectId: string;
	organizationId: string | null;
	/** Who pressed the button — the identity the model is resolved under. */
	actorUserId: string;
	/** The guidance recorded on the attempt row, or null. */
	guidance: string | null;
}

export interface GenerateCaseStudyOutput {
	/**
	 * `SUPERSEDED` is not an error. It means a deadline sweep reclaimed this
	 * attempt while the model was running and a newer one now owns the content
	 * type, so the compare-and-set refused the write. The workflow must NOT mark
	 * the row failed on this path — the row is already terminal, and the newer
	 * attempt is the one a reader should see.
	 */
	status: "READY" | "SUPERSEDED";
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

export async function generateCaseStudyActivity(
	input: GenerateCaseStudyInput,
): Promise<GenerateCaseStudyOutput> {
	const { draftId, topicId, projectId, organizationId, actorUserId } = input;

	heartbeat(`caseStudy: ${draftId}`);

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
		activity: "generateCaseStudyActivity",
	});

	const [
		boundPrompt,
		contextResult,
		contributors,
		roleClause,
		threads,
		latestAnalysis,
	] = await Promise.all([
		// `organizationId ?? undefined` is load-bearing: falsy takes the
		// personal USER → SYSTEM path, truthy takes ORG → SYSTEM, and the two
		// never cross (getBoundPromptVersion, prompts.ts).
		getBoundPromptForAgent({
			agentName: PUBLISHING_CASE_STUDY_AGENT_KEY,
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
		resolveContributorNames(topic.contributorUserIds as string[]),
		getProjectFunctionTagClause({
			projectId,
			requesterUserId: actorUserId,
			surface: "publishing-suite",
		}),
		listTopicDecisions({ topicId, projectId }),
		// The topic's latest READY analysis. Scoped by projectId like every
		// other read here; absent is a NORMAL answer, not a failure — UC3's
		// precondition is "sufficient planning context OR source context", so
		// a topic nobody has analysed still drafts from its raw sources.
		db.publishingTopicPlanningAnalysis.findFirst({
			where: { topicId, projectId, status: "READY" },
			orderBy: { version: "desc" },
			select: { content: true },
		}),
	]);

	heartbeat(`caseStudy: context assembled for ${draftId}`);

	// ANSWERED threads become instructions; OPEN restricting ones become
	// constraints. Two lists from one read, and both are derived here rather
	// than passed in, because the minutes between the button and this line are
	// exactly when someone answers a question.
	//
	// THE SPLIT. `restrictsPostType(thread, "CASE_STUDY")` is a superset of
	// `isRestrictingThread`: the shared safety-critical kinds plus
	// CLAIM_STRENGTH / AUDIENCE_SCOPE / CODEBASE_DETAIL. A thread that matches
	// the shared predicate is a SUBJECT the draft must write around; a thread
	// that matches only the per-type extra is a QUESTION about how the piece is
	// framed. Routing them into one list would put "Audience scope" under "NOT
	// approved for use … leave it out", which tells the model to strip the
	// audience framing — the opposite of caution on this content type.
	const decisions: CaseStudyDecision[] = [];
	const restricted: RestrictedSubjectRecord[] = [];
	const openQuestionSubjects: string[] = [];
	for (const thread of threads) {
		if (restrictsPostType(thread, "CASE_STUDY")) {
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

	const composed = await composeCaseStudyPrompt({
		templateBody:
			boundPrompt?.version?.content ??
			PUBLISHING_CASE_STUDY_FALLBACK_BODY,
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
		planningAnalysis: latestAnalysis?.content ?? null,
		decisions,
		guidance: input.guidance,
		restrictedSubjects: restricted.map((r) => r.label),
		openQuestionSubjects,
	});

	const prompt = composed.prompt + (roleClause ? `\n\n${roleClause}` : "");

	// Which prompt actually shaped this draft. Persisted rather than only
	// logged: a case study written from the default body because a bound prompt
	// would not render reads exactly like one written from the bound prompt.
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
			jobType: "publishing-case-study",
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
			schema: PublishingCaseStudySchema,
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
	const parsed = PublishingCaseStudySchema.safeParse(result.object);
	if (!parsed.success) {
		throw ApplicationFailure.nonRetryable(
			`Case study failed schema validation: ${parsed.error.message}`,
			"PUBLISHING_CASE_STUDY_SCHEMA_VALIDATION_FAILED",
		);
	}

	// -------------------------------------------------------------------------
	// THE CLAMP
	// -------------------------------------------------------------------------
	//
	// `customerIdentity`, `metricsBasis` and `confirmedAssets` are the three
	// things a downstream reader trusts without re-reading the narrative, and
	// all three are MODEL claims. A model that ignored the locked clause and
	// reported APPROVED — or listed a disputed screenshot as confirmed — while
	// the approval question is still open produces a draft that looks cleared.
	// This corrects the places where the topic's own state contradicts the
	// claim.
	//
	// Derived from the SAME `threads` array already in hand — deliberately not a
	// fresh query. The label has to describe THIS body, and this body was written
	// against that snapshot; re-reading would let a question answered during the
	// model call clear a draft that was written as though it were still open (or
	// flag one that was not).
	//
	// ONLY the two over-confident enum transitions. `ANONYMIZED` and
	// `QUALITATIVE` are TERMINAL SAFE STATES and survive untouched:
	//
	//  - Clamping them would tell an author their correctly-generalized draft is
	//    blocked on an approval it does not need. The draft deliberately does not
	//    name the customer; there is nothing for a CUSTOMER_NAME approval to
	//    unblock.
	//  - They are the only signal separating "the model complied with the locked
	//    clause" from "the model ignored it". Overwrite ANONYMIZED with
	//    APPROVAL_NEEDED and both outcomes store the same value, so nobody can
	//    ever tell whether the clause works.
	//
	// And it never upgrades: APPROVAL_NEEDED with no open question stays
	// APPROVAL_NEEDED. The model saw the narrative; a closed question is not
	// evidence that the story stopped needing approval.
	const openKinds = new Set(
		threads
			.filter(isRestrictingThread)
			.map((t) => t.root.decisionKind ?? "OTHER"),
	);

	// The reason strings come from `CASE_STUDY_CLAMP_REASON`, not from literals
	// here. The web panel that renders "Fabric set this" matches these values
	// from a DIFFERENT package, and an unrecognised value there maps to "not
	// clamped" — so a rename spelled on one side of that boundary makes the
	// warning VANISH while the lowered label stays: silent UNDER-warning, on the
	// surface whose whole job is to warn. Naming them once, in the leaf package
	// both sides import, is what turns that into a compile error instead.
	const clamped: CaseStudyClampRecord = {};
	const document = { ...parsed.data };
	if (
		openKinds.has(CASE_STUDY_CLAMP_REASON.customerIdentity) &&
		document.customerIdentity === "APPROVED"
	) {
		document.customerIdentity = "APPROVAL_NEEDED";
		clamped.customerIdentity = CASE_STUDY_CLAMP_REASON.customerIdentity;
	}
	if (
		openKinds.has(CASE_STUDY_CLAMP_REASON.metricsBasis) &&
		document.metricsBasis === "CONFIRMED"
	) {
		document.metricsBasis = "PLACEHOLDER";
		clamped.metricsBasis = CASE_STUDY_CLAMP_REASON.metricsBasis;
	}

	// ASSETS. `confirmedAssets` is a STRONGER publication claim than either
	// field above — the panel renders it as cleared for use — and it was the one
	// the clamp did not cover: a topic with an open ASSET_APPROVAL thread naming
	// the disputed asset shipped that asset as approved, because the model said
	// so and nothing checked. Same premise as the two transitions above: a model
	// self-claim a reader trusts has to be checked server-side.
	//
	// Matched by SUBJECT, never wholesale. An open approval about one asset says
	// nothing about an unrelated one, and demoting a whole list would teach the
	// reader to ignore it. `assetIsRestricted` is deliberately generous about
	// what counts as the same thing (containment either way, case- and
	// whitespace-folded): over-matching moves an asset to "needs confirmation",
	// which is the safe direction, while a miss leaves an unapproved asset
	// labelled ready to publish.
	//
	// Restricted subjects only, not open questions: a framing question is not a
	// claim about whether an asset exists and may be used.
	const assetRestrictedSubjects = restricted
		.filter((r) => ASSET_RESTRICTING_KINDS.has(r.kind))
		.map((r) => r.label);
	if (assetRestrictedSubjects.length > 0) {
		const demoted = document.confirmedAssets.filter((asset) =>
			assetIsRestricted(asset, assetRestrictedSubjects),
		);
		if (demoted.length > 0) {
			document.confirmedAssets = document.confirmedAssets.filter(
				(asset) => !assetIsRestricted(asset, assetRestrictedSubjects),
			);
			// De-duplicated against what the model already listed as needing
			// confirmation. A model that hedged by putting the same asset in
			// BOTH lists is not rare, and a demoted asset appearing twice reads
			// as two separate things still to chase.
			const needing = new Set(document.assetsNeedingConfirmation);
			document.assetsNeedingConfirmation = [
				...document.assetsNeedingConfirmation,
				...demoted.filter((asset) => !needing.has(asset)),
			];
			clamped.assets = demoted;
		}
	}

	if (clamped.customerIdentity || clamped.metricsBasis || clamped.assets) {
		logger.info(
			"[publishing-case-study] clamped a model claim against an open approval",
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
			// these three OFF A STORED CASE STUDY DRAFT: no procedure returns
			// them, no component renders them, no alert fires on them. They are
			// reachable only by querying the row.
			//
			// The names turn up elsewhere and mean something different there —
			// the meeting agenda has its own `provenance.formatOverridden`, and
			// the generation tab computes its own `openQuestionSubjects` from
			// the topic's LIVE threads. Neither is this block.
			//
			// They exist for the question asked after the fact — "what rules was
			// this draft written under?" — which cannot be reconstructed later,
			// because the topic's questions keep moving: answering one
			// afterwards would make a correctly-generalized draft look like it
			// generalized for no reason. The slice's rule is that a field gets a
			// reader or it does not get written; this is the deliberate
			// exception, not an oversight, and giving one of them a surface is a
			// change to that decision rather than a fix.
			formatOverridden: composed.formatOverridden,
			restrictedSubjects: restricted,
			openQuestionSubjects,
			// NOT write-only telemetry, and the one part of this block that is
			// not forensic-only: the panel reads `customerIdentity` and
			// `metricsBasis` off it to say "we lowered what the model claimed,
			// and here is the question that did it". Its reason values are the
			// shared `CASE_STUDY_CLAMP_REASON` constants precisely because that
			// reader lives in another package. `assets` carries the labels the
			// clamp moved out of `confirmedAssets`, so the demotion can be
			// attributed rather than looking like the model's own caution.
			clamped,
			guidance: input.guidance,
			generatedAt: new Date().toISOString(),
		},
	};

	const { persisted } = await completeTopicDraft({
		id: draftId,
		projectId,
		content,
		sourceRefs: contextResult.sourceRefs,
		model: metadata?.modelString ?? null,
		promptSource,
		promptId: boundPrompt?.id ?? null,
		promptVersion: boundPrompt?.version?.version ?? null,
	});

	if (!persisted) {
		logger.warn(
			"[publishing-case-study] draft superseded before it could be committed",
			{ draftId, topicId, projectId },
		);
		return { status: "SUPERSEDED", seededWorkingDraft: false };
	}

	// DV5/FR21: the first generation leaves the reader with something editable.
	// Deliberately AFTER the draft commits and in its own transaction, not
	// folded into `completeTopicDraft` — that helper is shared with the short
	// post, which must not seed (DV4).
	//
	// `composeCaseStudyWorkingDraftBody` comes from `@repo/utils` rather than
	// being composed here: `@repo/api` re-composes the same text when a stored
	// version is read back or adopted, and the two must agree byte-for-byte.
	// The Blog Post sibling duplicated its composer into the API layer and the
	// copies are pinned by nothing; one shared function makes the drift
	// impossible instead of documenting the risk of it.
	//
	// A crash between the two writes degrades rather than corrupts: the panel
	// shows a READY candidate with no working draft, which is the state a
	// regeneration produces anyway, and the adopt control resolves it.
	const seeded = await seedWorkingDraftIfAbsent({
		topicId,
		projectId,
		postType: "CASE_STUDY",
		sourceDraftId: draftId,
		body: composeCaseStudyWorkingDraftBody(document),
		updatedById: actorUserId,
	});

	if (seeded.status === "project_ineligible") {
		// The project was archived between the draft write and this one. The
		// draft is committed and READY, so this is not a failed generation —
		// it is a topic nobody can act on any more.
		logger.warn(
			"[publishing-case-study] project became ineligible before the working draft could be seeded",
			{ draftId, topicId, projectId },
		);
	} else if (seeded.status === "source_not_found") {
		// The draft this run just committed is no longer the READY row for this
		// content type: a newer attempt overtook it in the gap. Same shape as
		// SUPERSEDED, arriving one write later.
		logger.info(
			"[publishing-case-study] draft was superseded before it could seed a working draft",
			{ draftId, topicId, projectId },
		);
	} else if (seeded.status === "already_exists") {
		// The ordinary regeneration path, and the FR35 guarantee working as
		// designed. Debug, not warning: this is what most runs do.
		logger.debug(
			"[publishing-case-study] topic already has a working draft; left untouched",
			{ draftId, topicId, projectId },
		);
	}

	return {
		status: "READY",
		seededWorkingDraft: seeded.status === "seeded",
	};
}
