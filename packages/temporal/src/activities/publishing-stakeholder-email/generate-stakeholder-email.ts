/**
 * Stakeholder Email — the LLM activity (Publishing Suite Phase 2C, #1854).
 *
 * One model call, wrapped in the same guards its Case Study, Blog Post, Short
 * Post and Planning & Analysis siblings established. In order:
 *
 *  1. The topic is read re-scoped by `projectId`. A topic id is a client input
 *     everywhere it appears, and a valid id from another project must resolve
 *     to the same nothing a deleted one does (DV16).
 *  2. The actor's org membership is re-checked at the point of use, before any
 *     model is resolved. Org model resolution PREFERS the actor's personal
 *     provider, so an editor who starts a run and then loses org access would
 *     otherwise keep powering org work under their identity. Fail-closed via a
 *     non-retryable throw.
 *  3. Output is `safeParse`d before anything is written.
 *
 * The bound prompt is resolved HERE, in the activity, never in the workflow —
 * activity bodies are not replayed, so this adds no command to the workflow's
 * sequence and cannot cause TMPRL1100.
 *
 * THE RESTRICTION PASS SPLITS, exactly as the case study's does.
 * `restrictsPostType(thread, "STAKEHOLDER_EMAIL")` matches two kinds no 2B type
 * restricts (`AUDIENCE_SCOPE`, `CLAIM_STRENGTH`), and those are questions about
 * framing rather than subjects to omit — so they go into a second list with its
 * own locked-clause wording. See `buildStakeholderEmailLockedClauses`.
 *
 * WHAT THIS DOES NOT DO, AND WHY — the case study's server-side CLAMP has no
 * counterpart here, and that is a finding rather than an omission.
 *
 * The case study clamps three MODEL claims (`customerIdentity`, `metricsBasis`,
 * `confirmedAssets`) against the topic's open approval threads, and it can do
 * that because the claim and the thread name the same thing: `CUSTOMER_NAME`
 * asks "may we name the customer", and `customerIdentity: "APPROVED"` answers
 * it. The clamp is a comparison between two statements about one subject.
 *
 * `releaseStatus` has no such thread. Fabric's decision vocabulary is eleven
 * kinds — CUSTOMER_NAME, ASSET_APPROVAL, INTERNAL_UI, VIDEO_WALKTHROUGH,
 * CONTENT_TYPE, AUTHORSHIP, METRICS_APPROVAL, AUDIENCE_SCOPE, CLAIM_STRENGTH,
 * CODEBASE_DETAIL, OTHER (`PUBLISHING_DECISION_KINDS`) — and not one of them
 * asks whether the work shipped. Nor does anything else this activity reads:
 * `collectPlanningContext` returns work-item ids, titles and descriptions with
 * NO status field, documents, transcripts and PR coordinates; the topic row it
 * selects carries no release state either. The topic's own
 * `PublishingTopicStatus` is about the CONTENT — whether the post was published
 * — not about whether the feature is live, and reading it as the latter would
 * be a category error that clamps every topic anyone has finished writing about.
 *
 * The two candidate substitutes were considered and both are worse than nothing:
 *
 *  - Clamp SHIPPED to UNCONFIRMED on any open `CLAIM_STRENGTH` thread. That
 *    thread asks how strongly a RESULT may be stated — a latency number, an
 *    adoption figure — and says nothing about whether the thing is live. It
 *    would fire on most technical topics, demote correctly-SHIPPED emails, and
 *    teach the reader that "release status unconfirmed" means "Fabric was
 *    unsure about something else".
 *  - Infer shipping from the work items or the PR list. The model already has
 *    all of it, in more detail than a heuristic here could use, and a
 *    server-side re-derivation from a thinner view would contradict the draft
 *    on exactly the topics where the evidence is ambiguous.
 *
 * A clamp that cannot be derived from real data is worse than none: it puts a
 * "Fabric set this" label on a guess, which is precisely the authority the case
 * study's clamp earns by being a comparison against a recorded human decision.
 * So the release-status guarantee here is the LOCKED CLAUSE — the rule the org
 * cannot edit away, stating the word-to-state mapping and that UNCONFIRMED is
 * not a quieter UPCOMING — plus a panel that renders the claimed status as the
 * DRAFT's claim rather than as a cleared fact. If a `RELEASE_STATUS` decision
 * kind is ever added to `PUBLISHING_DECISION_KINDS`, the clamp becomes derivable
 * and should be built then; until then there is nothing to compare against.
 *
 * Like the case study, after the draft commits it seeds the topic's working
 * draft if the topic has none (DV5/FR21). The seeding call is CREATE-ONLY by
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
	isCurrentOrgMember,
	listTopicDecisions,
	seedWorkingDraftIfAbsent,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { TemplateFormat } from "@repo/utils";
import {
	isRestrictingThread,
	restrictionLabel,
	restrictsPostType,
} from "@repo/utils/publishing-restrictions";
import { composeStakeholderEmailWorkingDraftBody } from "@repo/utils/publishing-stakeholder-email-body";
import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { collectPlanningContext } from "../publishing-planning/collect-planning-context";
import { resolveContributorNames } from "../publishing-shared";
import {
	composeStakeholderEmailPrompt,
	PUBLISHING_STAKEHOLDER_EMAIL_AGENT_KEY,
	PUBLISHING_STAKEHOLDER_EMAIL_FALLBACK_BODY,
	PublishingStakeholderEmailSchema,
	type StakeholderEmailDecision,
} from "./build-stakeholder-email-prompt";

export interface GenerateStakeholderEmailInput {
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

export interface GenerateStakeholderEmailOutput {
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

export async function generateStakeholderEmailActivity(
	input: GenerateStakeholderEmailInput,
): Promise<GenerateStakeholderEmailOutput> {
	const { draftId, topicId, projectId, organizationId, actorUserId } = input;

	heartbeat(`stakeholderEmail: ${draftId}`);

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
	// resolves a model or spends the actor's provider quota.
	if (organizationId != null) {
		const stillMember = await isCurrentOrgMember(
			actorUserId,
			organizationId,
		);
		if (!stillMember) {
			throw ApplicationFailure.nonRetryable(
				"AI actor is no longer an org member",
				"PUBLISHING_ACTOR_INVALID",
			);
		}
	}

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
			agentName: PUBLISHING_STAKEHOLDER_EMAIL_AGENT_KEY,
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

	heartbeat(`stakeholderEmail: context assembled for ${draftId}`);

	// ANSWERED threads become instructions; OPEN restricting ones become
	// constraints. Two lists from one read, and both are derived here rather
	// than passed in, because the minutes between the button and this line are
	// exactly when someone answers a question.
	//
	// THE SPLIT. `restrictsPostType(thread, "STAKEHOLDER_EMAIL")` is a superset
	// of `isRestrictingThread`: the shared safety-critical kinds plus
	// AUDIENCE_SCOPE / CLAIM_STRENGTH. A thread that matches the shared
	// predicate is a SUBJECT the draft must write around; a thread that matches
	// only the per-type extra is a QUESTION about how the message is framed.
	// Routing them into one list would put "Audience scope" under "NOT approved
	// for use … leave it out", which tells the model to strip the audience
	// framing — on a format that is addressed to a named reader, the opposite of
	// caution.
	const decisions: StakeholderEmailDecision[] = [];
	const restricted: RestrictedSubjectRecord[] = [];
	const openQuestionSubjects: string[] = [];
	for (const thread of threads) {
		if (restrictsPostType(thread, "STAKEHOLDER_EMAIL")) {
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

	const composed = await composeStakeholderEmailPrompt({
		templateBody:
			boundPrompt?.version?.content ??
			PUBLISHING_STAKEHOLDER_EMAIL_FALLBACK_BODY,
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
	// logged: an email written from the default body because a bound prompt
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
			jobType: "publishing-stakeholder-email",
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
			schema: PublishingStakeholderEmailSchema,
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
	const parsed = PublishingStakeholderEmailSchema.safeParse(result.object);
	if (!parsed.success) {
		throw ApplicationFailure.nonRetryable(
			`Stakeholder email failed schema validation: ${parsed.error.message}`,
			"PUBLISHING_STAKEHOLDER_EMAIL_SCHEMA_VALIDATION_FAILED",
		);
	}

	const document = parsed.data;

	const content = {
		...document,
		generation: {
			promptSource,
			promptId: boundPrompt?.id ?? null,
			promptVersion: boundPrompt?.version?.version ?? null,
			// FORENSIC-ONLY, stated plainly so the next reader does not go
			// looking for the UI that shows them. NOTHING in this repo reads
			// these three OFF A STORED STAKEHOLDER EMAIL DRAFT: no procedure
			// returns them, no component renders them, no alert fires on them.
			// They are reachable only by querying the row.
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
			// exception, not an oversight.
			//
			// There is deliberately NO `clamped` key here, unlike the case
			// study's block. Nothing on this content type is clamped, because
			// nothing on it CAN be — see the file header. Writing an always-empty
			// `clamped: {}` would invite a panel to render "not clamped" as
			// evidence that a check ran.
			formatOverridden: composed.formatOverridden,
			restrictedSubjects: restricted,
			openQuestionSubjects,
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
			"[publishing-stakeholder-email] draft superseded before it could be committed",
			{ draftId, topicId, projectId },
		);
		return { status: "SUPERSEDED", seededWorkingDraft: false };
	}

	// DV5/FR21: the first generation leaves the reader with something editable.
	// Deliberately AFTER the draft commits and in its own transaction, not
	// folded into `completeTopicDraft` — that helper is shared with the short
	// post, which must not seed (DV4).
	//
	// `composeStakeholderEmailWorkingDraftBody` comes from `@repo/utils` rather
	// than being composed here: `@repo/api` re-composes the same text when a
	// stored version is adopted, and the two must agree byte-for-byte. The Blog
	// Post sibling duplicated its composer into the API layer and the copies
	// were pinned by nothing for two releases; one shared function makes the
	// drift impossible instead of documenting the risk of it.
	//
	// A crash between the two writes degrades rather than corrupts: the panel
	// shows a READY candidate with no working draft, which is the state a
	// regeneration produces anyway, and the adopt control resolves it.
	const seeded = await seedWorkingDraftIfAbsent({
		topicId,
		projectId,
		postType: "STAKEHOLDER_EMAIL",
		sourceDraftId: draftId,
		body: composeStakeholderEmailWorkingDraftBody(document),
		updatedById: actorUserId,
	});

	if (seeded.status === "project_ineligible") {
		// The project was archived between the draft write and this one. The
		// draft is committed and READY, so this is not a failed generation —
		// it is a topic nobody can act on any more.
		logger.warn(
			"[publishing-stakeholder-email] project became ineligible before the working draft could be seeded",
			{ draftId, topicId, projectId },
		);
	} else if (seeded.status === "source_not_found") {
		// The draft this run just committed is no longer the READY row for this
		// content type: a newer attempt overtook it in the gap. Same shape as
		// SUPERSEDED, arriving one write later.
		logger.info(
			"[publishing-stakeholder-email] draft was superseded before it could seed a working draft",
			{ draftId, topicId, projectId },
		);
	} else if (seeded.status === "already_exists") {
		// The ordinary regeneration path, and the FR35 guarantee working as
		// designed. Debug, not warning: this is what most runs do.
		logger.debug(
			"[publishing-stakeholder-email] topic already has a working draft; left untouched",
			{ draftId, topicId, projectId },
		);
	}

	return {
		status: "READY",
		seededWorkingDraft: seeded.status === "seeded",
	};
}
