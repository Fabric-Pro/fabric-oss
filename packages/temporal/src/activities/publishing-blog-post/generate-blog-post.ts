/**
 * Blog Post — the LLM activity (Publishing Suite Phase 2B-3, #1853).
 *
 * One model call, wrapped in the same guards its Short Post and Planning &
 * Analysis siblings established. In order:
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
 * ONE THING THIS DOES THAT THE SHORT POST DOES NOT: after the draft commits, it
 * seeds the topic's working draft if the topic has none (DV5/FR21). The short
 * post deliberately does not (DV4) — its three options stay candidates until a
 * person picks one. The seeding call is CREATE-ONLY by construction, so a
 * regeneration cannot reach an existing draft and FR35 holds without a
 * condition here having to be right.
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
import {
	isRestrictingThread,
	restrictionLabel,
} from "@repo/utils/publishing-restrictions";
import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { collectPlanningContext } from "../publishing-planning/collect-planning-context";
import {
	assertGenerationActorAuthorized,
	resolveContributorNames,
} from "../publishing-shared";
import {
	type BlogPostDecision,
	composeBlogPostPrompt,
	composeWorkingDraftBody,
	PUBLISHING_BLOG_POST_AGENT_KEY,
	PUBLISHING_BLOG_POST_FALLBACK_BODY,
	PublishingBlogPostSchema,
} from "./build-blog-post-prompt";

export interface GenerateBlogPostInput {
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

export interface GenerateBlogPostOutput {
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

export async function generateBlogPostActivity(
	input: GenerateBlogPostInput,
): Promise<GenerateBlogPostOutput> {
	const { draftId, topicId, projectId, organizationId, actorUserId } = input;

	heartbeat(`blogPost: ${draftId}`);

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
		activity: "generateBlogPostActivity",
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
			agentName: PUBLISHING_BLOG_POST_AGENT_KEY,
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

	heartbeat(`blogPost: context assembled for ${draftId}`);

	// ANSWERED threads become instructions; OPEN safety-critical ones become
	// restrictions. Two lists from one read, and both are derived here rather
	// than passed in, because the minutes between the button and this line are
	// exactly when someone answers a question.
	const decisions: BlogPostDecision[] = [];
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

	const composed = await composeBlogPostPrompt({
		templateBody:
			boundPrompt?.version?.content ?? PUBLISHING_BLOG_POST_FALLBACK_BODY,
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
	// logged: a post written from the default body because a bound prompt would
	// not render reads exactly like one written from the bound prompt.
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
			jobType: "publishing-blog-post",
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
			schema: PublishingBlogPostSchema,
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
	const parsed = PublishingBlogPostSchema.safeParse(result.object);
	if (!parsed.success) {
		throw ApplicationFailure.nonRetryable(
			`Blog post failed schema validation: ${parsed.error.message}`,
			"PUBLISHING_BLOG_POST_SCHEMA_VALIDATION_FAILED",
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
			"[publishing-blog-post] draft superseded before it could be committed",
			{ draftId, topicId, projectId },
		);
		return { status: "SUPERSEDED", seededWorkingDraft: false };
	}

	// DV5/FR21: the first generation leaves the reader with something editable.
	// Deliberately AFTER the draft commits and in its own transaction, not
	// folded into `completeTopicDraft` — that helper is shared with the short
	// post, which must not seed (DV4), and a postType branch inside it would be
	// exactly the flag deciding which product it is that keeping these two
	// slices apart was meant to avoid.
	//
	// A crash between the two writes degrades rather than corrupts: the panel
	// shows a READY candidate with no working draft, which is the state a
	// regeneration produces anyway, and the adopt control resolves it.
	const seeded = await seedWorkingDraftIfAbsent({
		topicId,
		projectId,
		postType: "BLOG_POST",
		sourceDraftId: draftId,
		body: composeWorkingDraftBody(parsed.data),
		updatedById: actorUserId,
	});

	if (seeded.status === "project_ineligible") {
		// The project was archived between the draft write and this one. The
		// draft is committed and READY, so this is not a failed generation —
		// it is a topic nobody can act on any more.
		logger.warn(
			"[publishing-blog-post] project became ineligible before the working draft could be seeded",
			{ draftId, topicId, projectId },
		);
	} else if (seeded.status === "source_not_found") {
		// The draft this run just committed is no longer the READY row for this
		// content type: a newer attempt overtook it in the gap. Same shape as
		// SUPERSEDED, arriving one write later.
		logger.info(
			"[publishing-blog-post] draft was superseded before it could seed a working draft",
			{ draftId, topicId, projectId },
		);
	} else if (seeded.status === "already_exists") {
		// The ordinary regeneration path, and the FR35 guarantee working as
		// designed. Debug, not warning: this is what most runs do.
		logger.debug(
			"[publishing-blog-post] topic already has a working draft; left untouched",
			{ draftId, topicId, projectId },
		);
	}

	return {
		status: "READY",
		seededWorkingDraft: seeded.status === "seeded",
	};
}
