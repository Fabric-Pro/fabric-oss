/**
 * Short Post / Tweet — the LLM activity (Publishing Suite Phase 2B-2, #1853).
 *
 * One model call, wrapped in the same guards its Planning & Analysis sibling
 * established. In order:
 *
 *  1. The topic is read re-scoped by `projectId`. A topic id is a client input
 *     everywhere it appears, and a valid id from another project must resolve
 *     to the same nothing a deleted one does (DV16).
 *  2. The actor's org membership is re-checked at the point of use, before any
 *     model is resolved. Org model resolution PREFERS the actor's personal
 *     provider, so an editor who starts a run and then loses org access would
 *     otherwise keep powering org work under their identity. Fail-closed via a
 *     non-retryable throw.
 *  3. Output is `safeParse`d before anything is written. A two-option run
 *     persisted as READY is worse than a visible failure: the panel would render
 *     it as a finished answer and FR16's "exactly three" would be broken with
 *     nothing downstream ever noticing.
 *
 * The bound prompt is resolved HERE, in the activity, never in the workflow —
 * activity bodies are not replayed, so this adds no command to the workflow's
 * sequence and cannot cause TMPRL1100.
 *
 * This activity COMMITS its own success, and the workflow owns the failure
 * marker. Splitting the write out would open a window where the model call
 * succeeded and three drafted posts were lost, paid for by a second multi-minute
 * run; and by definition an activity that has just failed is not the thing to
 * ask for a record of its failure.
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
} from "@repo/database";
import { logger } from "@repo/logs";
import type { TemplateFormat } from "@repo/utils";
import {
	isRestrictingThread,
	restrictionLabel,
} from "@repo/utils/publishing-restrictions";
import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { collectPlanningContext } from "../publishing-planning/collect-planning-context";
import { resolveContributorNames } from "../publishing-shared";
import {
	composeShortPostPrompt,
	PUBLISHING_SHORT_POST_AGENT_KEY,
	PUBLISHING_SHORT_POST_FALLBACK_BODY,
	PublishingShortPostSchema,
	type ShortPostDecision,
} from "./build-short-post-prompt";

export interface GenerateShortPostInput {
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

export interface GenerateShortPostOutput {
	/**
	 * `SUPERSEDED` is not an error. It means a deadline sweep reclaimed this
	 * attempt while the model was running and a newer one now owns the content
	 * type, so the compare-and-set refused the write. The workflow must NOT mark
	 * the row failed on this path — the row is already terminal, and the newer
	 * attempt is the one a reader should see.
	 */
	status: "READY" | "SUPERSEDED";
}

export async function generateShortPostActivity(
	input: GenerateShortPostInput,
): Promise<GenerateShortPostOutput> {
	const { draftId, topicId, projectId, organizationId, actorUserId } = input;

	heartbeat(`shortPost: ${draftId}`);

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
			agentName: PUBLISHING_SHORT_POST_AGENT_KEY,
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
		// other read here; absent is a NORMAL answer, not a failure — UC2's
		// precondition is "sufficient planning context OR source context", so
		// a topic nobody has analysed still drafts from its raw sources.
		db.publishingTopicPlanningAnalysis.findFirst({
			where: { topicId, projectId, status: "READY" },
			orderBy: { version: "desc" },
			select: { content: true },
		}),
	]);

	heartbeat(`shortPost: context assembled for ${draftId}`);

	// ANSWERED threads become instructions; OPEN safety-critical ones become
	// restrictions. Two lists from one read, and both are derived here rather
	// than passed in, because the minutes between the button and this line are
	// exactly when someone answers a question.
	const decisions: ShortPostDecision[] = [];
	const restrictedSubjects: string[] = [];
	for (const thread of threads) {
		if (isRestrictingThread(thread)) {
			restrictedSubjects.push(restrictionLabel(thread));
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

	const composed = await composeShortPostPrompt({
		templateBody:
			boundPrompt?.version?.content ??
			PUBLISHING_SHORT_POST_FALLBACK_BODY,
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
		restrictedSubjects,
	});

	const prompt = composed.prompt + (roleClause ? `\n\n${roleClause}` : "");

	// Which prompt actually shaped this draft. Persisted rather than only
	// logged: three posts written from the default body because a bound prompt
	// would not render read exactly like three written from the bound prompt.
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
			jobType: "publishing-short-post",
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
			schema: PublishingShortPostSchema,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			// Azure/OpenAI reject a strict JSON schema containing optional fields
			// outright (bug #1681), and this schema has three. The AI SDK still
			// validates the object against the zod schema.
			providerOptions: { openai: { strictJsonSchema: false } },
		});
	} finally {
		clearInterval(beat);
	}

	trackUsage();

	// Fail closed. `generateObject` already validates, but it is not the only way
	// an object reaches this line — and the cost of being wrong is a panel that
	// renders two options as though three were the contract.
	const parsed = PublishingShortPostSchema.safeParse(result.object);
	if (!parsed.success) {
		throw ApplicationFailure.nonRetryable(
			`Short post failed schema validation: ${parsed.error.message}`,
			"PUBLISHING_SHORT_POST_SCHEMA_VALIDATION_FAILED",
		);
	}

	const content = {
		...parsed.data,
		generation: {
			promptSource,
			promptId: boundPrompt?.id ?? null,
			promptVersion: boundPrompt?.version?.version ?? null,
			formatOverridden: composed.formatOverridden,
			// What the draft was told to write around. Recorded on the draft
			// itself because the topic's questions keep moving: answering one
			// after the fact would otherwise make a correctly-generalized draft
			// look like it generalized for no reason.
			restrictedSubjects,
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
			"[publishing-short-post] draft superseded before it could be committed",
			{ draftId, topicId, projectId },
		);
		return { status: "SUPERSEDED" };
	}

	return { status: "READY" };
}
