import { ORPCError } from "@orpc/client";
import {
	getInBodyAttachmentPreservationClause,
	getLockedAttachmentRulesClause,
} from "@repo/agent-prompts";
import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { config } from "@repo/config";
import {
	buildFabricStoryUrl,
	createFeatureVersion,
	db,
	type FeatureDraftingStage,
	FeatureDraftingStageSchema,
	getBoundPromptForAgent,
	getFeatureMaturationState,
	getPromptById,
	getStoryById,
	placeFabricBackLink,
	type StoryKind,
	setLastContextUpdateAt,
	updateStory,
	updateStoryDraftingStage,
} from "@repo/database";
import { listDecisionLogThreads } from "@repo/database/prisma/queries/feature-maturation";
import { logger } from "@repo/logs";
import { formatContextsForPrompt, retrieveProjectContexts } from "@repo/rag";
import {
	fetchLiveIntegrationContext,
	formatLiveContextForPrompt,
} from "@repo/rag/lib/project-contexts/live-integration-context";
import { getStorageProvider } from "@repo/storage";
import {
	formatLiveUrlSourcesForPrompt,
	gatherLiveUrlSources,
} from "@repo/temporal/activities";
import {
	CLEAN_SPEC_DOCUMENT_TYPE,
	cleanSpecAgentForKind,
} from "@repo/temporal/clean-spec-agent-for-kind";
import { renderTemplate, type TemplateFormat } from "@repo/utils";
import {
	combineCleanSpec,
	recoveredAcceptanceCriteria,
	separateEmbeddedAcceptanceCriteria,
} from "@repo/utils/clean-spec-content";
import { zodSchema } from "ai";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationMembership,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { runInBackground } from "../../../weave/lib/run-in-background";
import { maybeAutoDraftOnStageChange } from "../../lib/auto-draft-test-cases";
import { enqueuePmSync } from "../../lib/enqueue-pm-sync";
import { extractMaturationQuestions } from "../../lib/extract-maturation-questions";
import { extractStoryMediaKeysFromContent } from "../../lib/extract-story-media-keys";
import { logReinjectedAttachments } from "../../lib/log-reinjected-attachments";
import { getPendingDecisionsIntegrationClause } from "../../lib/record-answer-in-spec";
import { resolveStoryAttachmentAiContexts } from "../../lib/story-attachment-ai-context";
import { stripInternalStoryFields } from "../../lib/strip-internal-story-fields";
import { validatePromptForKind } from "../../lib/validate-prompt-for-kind";
import { validateStageForKind } from "../../lib/validate-stage-for-kind";

const EnhancedFeatureSchema = z.object({
	description: z
		.string()
		.describe("The enhanced feature description in markdown."),
	acceptanceCriteria: z
		.string()
		.optional()
		.describe(
			"Acceptance criteria in markdown. Only include if present in the original or if the prompt asks for it.",
		),
	changeSummary: z
		.array(z.string())
		.optional()
		.describe(
			"A short reviewer-facing list of the substantive changes you just made to this spec — 3 to 8 bullets, one per meaningful change, each ONE sentence prefixed with the affected section, e.g. 'Must Haves — restricted MFA methods to email and SMS'. So the PO reviews a handful of lines instead of a full diff. Omit trivial wording/formatting tweaks. Empty array if nothing substantive changed.",
		),
});

async function enhanceFeatureWithAI({
	title,
	description,
	acceptanceCriteria,
	storyKind,
	prompt,
	projectContext,
	ragContext,
	liveIntegrationContext,
	liveUrlContext,
	featureDecisionContext,
	userId,
	organizationId,
	projectId,
}: {
	title: string;
	description: string;
	acceptanceCriteria?: string | null;
	/**
	 * Decides whether an acceptance heading found inside the returned
	 * description is a section the model misplaced or a legitimate part of the
	 * body. A BUG is drafted as ONE markdown document whose template carries
	 * `## Acceptance Criteria (Fix Verification)`, and its criteria column is
	 * deliberately kept empty — splitting there would carve up the bug card.
	 */
	storyKind: StoryKind;
	prompt: string;
	projectContext?: string;
	ragContext?: string;
	liveIntegrationContext?: string;
	liveUrlContext?: string;
	featureDecisionContext?: string;
	userId: string;
	organizationId?: string;
	projectId?: string;
}): Promise<{
	description: string;
	acceptanceCriteria?: string;
	changeSummary: string[];
} | null> {
	try {
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{ userId, organizationId, featureKey: "enhance-feature" },
		);

		const parts = [
			prompt,
			// Shared system-level guarantee that in-body story-media images
			// and fenced code blocks survive the rewrite, and that chat-
			// attachment transport tokens are never embedded into the
			// document body. Single source of truth in `@repo/agent-prompts`
			// so this surface and the langgraph agent prompt builder
			// (`buildSystemPromptAsync`) cannot drift.
			getInBodyAttachmentPreservationClause(),
			// FR-25: dedicated-attachment rule block —
			// `StoryAttachment` assets are read-only reference material the AI must
			// never modify, delete, invent, or claim to have analysed. Single source
			// of truth in `@repo/agent-prompts`; the langgraph agent builder
			// (`buildSystemPromptAsync`) appends the identical clause so the two
			// surfaces cannot drift.
			//
			// No longer a no-op: `ragContext` below can now carry the text of this
			// story's context-only (UNLOCKED) attachments, so the clause is what
			// tells the model which files it actually received and which it only
			// knows the name of.
			getLockedAttachmentRulesClause(),
			// V2 notebook model: dissolve the transient pending-decisions appendix
			// (written deterministically when the PO answers a question) into the
			// body / Constraints, and remove the appendix. Kept in code so it holds
			// regardless of the org's editable bound prompt.
			getPendingDecisionsIntegrationClause(),
			projectContext ? `\nProject context:\n${projectContext}` : "",
			ragContext ? `\n${ragContext}` : "",
			liveIntegrationContext ? `\n${liveIntegrationContext}` : "",
			// Live URL sources — fresh markdown scraped at
			// retrieval time, NOT from Qdrant. Block already self-labels with
			// "## Live URL content" so the LLM can attribute correctly.
			liveUrlContext ? `\n${liveUrlContext}` : "",
			featureDecisionContext
				? `\nFeature decision log context:\n${featureDecisionContext}`
				: "",
			`\nFeature title: ${title}`,
			`\nCurrent description:\n${description || "(empty)"}`,
			acceptanceCriteria
				? `\nCurrent acceptance criteria:\n${acceptanceCriteria}`
				: "",
		];

		// Fizzy #1767 Stage 4: append the project's function-tag
		// role-composition clause (flag-gated, self-authorizing — see
		// getProjectFunctionTagClause) so the model knows who's on the
		// project and in what capacity. `projectId` is optional here
		// (feature enhancement can run without one); no-op when absent, when
		// the flag is off, or when no roster member holds a tag.
		const roleClause = projectId
			? await getProjectFunctionTagClause({
					projectId,
					requesterUserId: userId,
					surface: "enhance-feature",
				})
			: "";
		if (roleClause) {
			parts.push(roleClause);
		}

		const generationStart = Date.now();
		const finalPrompt = parts.filter(Boolean).join("\n");
		// Scaled mode: the schema returns the FULL enhanced description (+ AC), so
		// output tracks the spec being rewritten. Without an explicit budget
		// Databricks/Anthropic-direct truncate the rewrite at their injected
		// defaults; `undefined` for providers that don't need the workaround.
		const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
			inputChars: description.length + (acceptanceCriteria?.length ?? 0),
			promptChars: finalPrompt.length,
		});
		const { object, usage } = await generateObject({
			model,
			schema: zodSchema(EnhancedFeatureSchema),
			prompt: finalPrompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});

		trackUsage();
		logModelUsageAsync({
			context: { userId, organizationId },
			metadata,
			taskType: "COMPLEX",
			usage,
			latencyMs: Date.now() - generationStart,
			projectId,
		});

		const enhanced = {
			description: object.description,
			acceptanceCriteria: object.acceptanceCriteria,
			changeSummary: object.changeSummary ?? [],
		};
		// Same contract as the create path: the schema asks for the two fields
		// separately and the model may still fold the criteria into the
		// description under the template's own heading. Bugs are exempt — see
		// `storyKind` above.
		if (storyKind === "BUG") {
			return enhanced;
		}
		const separated = separateEmbeddedAcceptanceCriteria(enhanced);
		if (recoveredAcceptanceCriteria(enhanced, separated)) {
			logger.warn("story.criteria_recovered_from_description", {
				projectId,
				surface: "enhance",
			});
		}
		return separated;
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			return null;
		}
		console.error("AI feature enhancement failed:", error);
		return null;
	}
}

export const enhanceFeatureProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/enhance",
		tags: ["Projects", "Features"],
		summary: "Enhance feature with AI",
		description:
			"AI-powered feature enhancement for drafting stage transitions",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			// Optional when `cleanSpecRefresh` is set — a refresh keeps the current
			// drafting stage. Required for an ordinary stage transition.
			targetStage: FeatureDraftingStageSchema.optional(),
			promptId: z.string().optional(),
			/**
			 * Feature Maturation V2 single-prompt mode (#1/#4b/#6). When true, resolve
			 * the org-editable `feature_clean_spec_generator` / `CLEAN_SPEC` prompt
			 * instead of the per-stage prompt, and DO NOT change the drafting stage —
			 * this is the "Refresh Clean Spec" action that rebuilds the spec (and
			 * dissolves answered-question decisions) without walking the stage ladder.
			 * Reuses the whole enhance pipeline (context, attachment preservation,
			 * versioning, PM sync, question extraction + reconciliation).
			 */
			cleanSpecRefresh: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (organizationId) {
			await requireOrganizationMembership(
				organizationId,
				context.user.id,
			);
		}

		const story = await getStoryById(input.storyId, input.projectId);
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Feature not found",
			});
		}

		const isCleanSpecRefresh = input.cleanSpecRefresh === true;
		// A refresh holds the current stage; a transition moves to targetStage.
		const effectiveStage = (input.targetStage ??
			story.draftingStage) as FeatureDraftingStage;
		if (!isCleanSpecRefresh) {
			if (!input.targetStage) {
				throw new ORPCError("BAD_REQUEST", {
					message: "targetStage is required for a stage transition",
				});
			}
			validateStageForKind(input.targetStage, story.kind);
		}

		// Resolve prompt: explicit promptId > bound prompt > none. The bound prompt
		// is the single Clean Spec prompt in refresh mode, else the per-stage prompt.
		let resolvedPrompt: {
			content: string;
			format: TemplateFormat;
			key: string;
			source: "explicitPrompt" | "bound";
		} | null = null;
		if (input.promptId) {
			const prompt = await getPromptById(input.promptId, {
				userId: user.id,
				organizationId,
			});
			if (prompt?.versions?.[0]?.content?.trim()) {
				// This branch used to be the one place `story.kind` was never
				// consulted: a prompt named by the caller ran on the work item
				// whatever it was bound to. Refuse a cross-kind choice here,
				// before any version is written (#2048 R3 / AE2). Deny by
				// default — a prompt with no binding at this document type is
				// refused, not assumed kind-agnostic.
				await validatePromptForKind({
					promptId: input.promptId,
					promptLabel: prompt.name || prompt.key,
					kind: story.kind,
					documentType: isCleanSpecRefresh
						? CLEAN_SPEC_DOCUMENT_TYPE
						: effectiveStage,
					userId: user.id,
					organizationId,
				});
				resolvedPrompt = {
					content: prompt.versions[0].content,
					format: prompt.format as TemplateFormat,
					key: prompt.key,
					source: "explicitPrompt",
				};
			}
		} else {
			// In refresh mode resolve the single Clean Spec prompt, kind-scoped so
			// bugs and features each get their own editable prompt (#R1). The
			// kind→agent mapping has ONE home (Fizzy #2048) — never re-derive it
			// inline here.
			const boundPrompt = await getBoundPromptForAgent({
				agentName: isCleanSpecRefresh
					? cleanSpecAgentForKind(story.kind)
					: "project_document_generator",
				documentType: isCleanSpecRefresh
					? CLEAN_SPEC_DOCUMENT_TYPE
					: effectiveStage,
				storyKind: story.kind,
				userId: user.id,
				organizationId,
			});
			if (boundPrompt?.version?.content?.trim()) {
				resolvedPrompt = {
					content: boundPrompt.version.content,
					format: boundPrompt.format as TemplateFormat,
					key: boundPrompt.key,
					source: "bound",
				};
			}
		}

		// No prompt configured (or prompt is empty). A refresh has nothing to do; a
		// transition still advances the stage.
		if (!resolvedPrompt) {
			if (isCleanSpecRefresh) {
				return {
					story: stripInternalStoryFields(story),
					aiEnhanced: false,
				};
			}
			const updatedStory = await updateStoryDraftingStage(
				input.storyId,
				input.projectId,
				effectiveStage,
				{
					lastEditedByName: user.name ?? null,
					lastEditedSource: "AI_MATURATION",
				},
			);
			// The stage advanced even though the AI part did not run, so the
			// test-first trigger owes the same drafting run it would owe on any
			// other route to Ready for Dev.
			runInBackground(
				maybeAutoDraftOnStageChange({
					projectId: input.projectId,
					storyId: input.storyId,
					userId: user.id,
					previousStage: story.draftingStage,
					targetStage: effectiveStage,
				}),
			);
			return {
				story: stripInternalStoryFields(updatedStory),
				aiEnhanced: false,
			};
		}

		// Fetch project metadata, RAG context, live integration context, and
		// live URL sources in parallel. Live URL sources come from
		// `gatherLiveUrlSources` (URL Context Sources, spec §8.2/§8.3) — fresh
		// markdown scraped at retrieval time, never persisted to Qdrant.
		const [
			projectSettled,
			ragSettled,
			liveSettled,
			liveUrlSettled,
			decisionLogSettled,
			attachmentSettled,
		] = await Promise.allSettled([
			db.project.findUnique({
				where: { id: input.projectId },
				select: { name: true, description: true, techStack: true },
			}),
			(async () => {
				const contexts = await retrieveProjectContexts({
					projectId: input.projectId,
					query: `${story.title} ${story.description || ""}`.trim(),
					userId: user.id,
					organizationId,
					topK: 5,
				});
				return contexts.length > 0
					? formatContextsForPrompt(contexts)
					: null;
			})(),
			(async () => {
				const liveContext = await fetchLiveIntegrationContext({
					projectId: input.projectId,
					userId: user.id,
					organizationId,
					teamsLimit: 15,
					slackLimit: 15,
				});
				return formatLiveContextForPrompt(liveContext) || null;
			})(),
			(async () => {
				const liveUrls = await gatherLiveUrlSources({
					projectId: input.projectId,
					userId: user.id,
					organizationId: organizationId ?? null,
				});
				return liveUrls.length > 0
					? formatLiveUrlSourcesForPrompt(liveUrls)
					: null;
			})(),
			(async () => {
				const threads = await listDecisionLogThreads({
					tenantFilter: {
						userId: user.id,
						organizationId: organizationId ?? null,
					},
					userStoryId: input.storyId,
					// Feeds an AI prompt — a retracted answer must not reach the model (#1910).
					excludeSuperseded: true,
				});
				if (threads.length === 0) {
					return null;
				}

				const lines = [
					"Use resolved decisions as authoritative constraints for this feature; do not re-open rejected paths.",
					"",
					...threads.map((thread, index) => {
						const rootText =
							thread.root.summary?.trim() ||
							thread.root.content?.trim() ||
							"(no summary provided)";
						const latestReply =
							thread.replies.length > 0
								? thread.replies[thread.replies.length - 1]
								: null;
						const latestReplyText =
							latestReply?.summary?.trim() ||
							latestReply?.content?.trim() ||
							"";
						return [
							`${index + 1}. [${thread.root.status}] ${rootText}`,
							thread.root.topic
								? `   Topic: ${thread.root.topic}`
								: "",
							latestReplyText
								? `   Latest reply: ${latestReplyText}`
								: "",
						]
							.filter(Boolean)
							.join("\n");
					}),
				];

				return lines.join("\n");
			})(),
			// Context-only (UNLOCKED) attachments on this work item. Settled
			// alongside the rest so one unreadable file cannot stall or fail
			// the enhancement — the resolver already swallows per-file
			// failures, and this catches anything above it.
			//
			// `organizationId` is the RESOLVED tenant, not `input.organizationId`.
			// The three sibling fetches above pass the same value, and
			// `resolveOrganizationId` exists precisely because the two differ —
			// a cross-org guest sends null and gets mapped to the effective org.
			resolveStoryAttachmentAiContexts(input.storyId, {
				userId: user.id,
				organizationId: organizationId ?? null,
			}),
		]);

		const project =
			projectSettled.status === "fulfilled" ? projectSettled.value : null;
		const ragResult =
			ragSettled.status === "fulfilled" ? ragSettled.value : null;
		const liveResult =
			liveSettled.status === "fulfilled" ? liveSettled.value : null;
		const liveUrlResult =
			liveUrlSettled.status === "fulfilled" ? liveUrlSettled.value : null;
		const decisionLogContext =
			decisionLogSettled.status === "fulfilled"
				? decisionLogSettled.value
				: null;
		const attachmentContexts =
			attachmentSettled.status === "fulfilled"
				? attachmentSettled.value
				: [];

		if (attachmentSettled.status === "rejected") {
			console.error(
				"[Feature Enhancement] Attachment context resolve failed:",
				attachmentSettled.reason,
			);
		}
		if (ragSettled.status === "rejected") {
			console.error(
				"[Feature Enhancement] RAG context fetch failed:",
				ragSettled.reason,
			);
		}
		if (liveSettled.status === "rejected") {
			console.error(
				"[Feature Enhancement] Live context fetch failed:",
				liveSettled.reason,
			);
		}
		if (liveUrlSettled.status === "rejected") {
			console.error(
				"[Feature Enhancement] Live URL gather failed:",
				liveUrlSettled.reason,
			);
		}
		if (decisionLogSettled.status === "rejected") {
			console.error(
				"[Feature Enhancement] Decision Log context fetch failed:",
				decisionLogSettled.reason,
			);
		}

		// Attachment text leads, retrieved chunks follow. The order is the one
		// the chat path settled on: a file the user deliberately attached is
		// stronger evidence of intent than a chunk similarity happened to
		// surface, and the envelope tells the model it has already read the
		// former in full.
		const ragWithAttachments =
			attachmentContexts.length > 0
				? [...attachmentContexts, ragResult ?? ""]
						.filter((part) => part.trim().length > 0)
						.join("\n\n")
				: ragResult;

		const projectContext = project
			? `Project: ${project.name}${project.description ? `\n${project.description}` : ""}`
			: undefined;

		// Render templated prompt content so bound stage prompts with
		// {{featureTitle}} etc. reach the model as resolved text, not raw
		// template syntax. MARKDOWN/PLAIN_TEXT prompts pass through unchanged.
		const rendered = await renderTemplate({
			format: resolvedPrompt.format,
			template: resolvedPrompt.content,
			variables: {
				featureIdentifier: story.identifier ?? "",
				featureTitle: story.title,
				featureDescription: story.description ?? "",
				acceptanceCriteria: story.acceptanceCriteria ?? "",
				projectName: project?.name ?? "",
				projectDescription: project?.description ?? "",
				techStack: project?.techStack?.join(", ") ?? "",
			},
		});
		if (rendered.error) {
			console.error(
				"[Feature Enhancement] Template render failed, using raw content:",
				rendered.error,
			);
		}

		logger.info("[enhanceFeature] drafting", {
			projectId: input.projectId,
			storyId: input.storyId,
			targetStage: effectiveStage,
			cleanSpecRefresh: isCleanSpecRefresh,
			storyKind: story.kind,
			promptKey: resolvedPrompt.key,
			promptSource: resolvedPrompt.source,
			projectContextChars: projectContext?.length ?? 0,
			ragContextChars: ragWithAttachments?.length ?? 0,
			attachmentContextCount: attachmentContexts.length,
			liveContextChars: liveResult?.length ?? 0,
			liveUrlContextChars: liveUrlResult?.length ?? 0,
			decisionLogContextChars: decisionLogContext?.length ?? 0,
		});

		const enhanced = await enhanceFeatureWithAI({
			title: story.title,
			description: story.description ?? "",
			acceptanceCriteria: story.acceptanceCriteria,
			storyKind: story.kind,
			prompt: rendered.rendered,
			projectContext,
			ragContext: ragWithAttachments ?? undefined,
			liveIntegrationContext: liveResult ?? undefined,
			liveUrlContext: liveUrlResult ?? undefined,
			featureDecisionContext: decisionLogContext ?? undefined,
			userId: user.id,
			organizationId,
			projectId: input.projectId,
		});

		if (!enhanced) {
			// AI failed. A refresh leaves the spec/stage untouched; a transition
			// still advances the stage.
			if (isCleanSpecRefresh) {
				return {
					story: stripInternalStoryFields(story),
					aiEnhanced: false,
				};
			}
			const updatedStory = await updateStoryDraftingStage(
				input.storyId,
				input.projectId,
				effectiveStage,
				{
					lastEditedByName: user.name ?? null,
					lastEditedSource: "AI_MATURATION",
				},
			);
			// The stage advanced even though the AI part did not run, so the
			// test-first trigger owes the same drafting run it would owe on any
			// other route to Ready for Dev.
			runInBackground(
				maybeAutoDraftOnStageChange({
					projectId: input.projectId,
					storyId: input.storyId,
					userId: user.id,
					previousStage: story.draftingStage,
					targetStage: effectiveStage,
				}),
			);
			return {
				story: stripInternalStoryFields(updatedStory),
				aiEnhanced: false,
			};
		}

		// Auto-reinject `story-media/` keys that the model dropped on the
		// rewrite. Belt-and-braces guard for the prompt-level preservation
		// clause appended in `enhanceFeatureWithAI`'s `parts` array: the
		// clause is the cheap correct fix in the happy path; this guard
		// recovers silently when model nondeterminism still strips an inline
		// image. Per spec §6 + decisions.md D3, recovery is a `warn` log and
		// an `## Attachments` reinjection — never an ORPCError, never a
		// user-visible toast (the user accepted the AI improvements and the
		// images live alongside them).
		// Both sides read the WHOLE spec, not just `description`. An image is
		// only dropped if it is gone from the feature entirely — moving between
		// the two columns is a relocation, and asking the question of one column
		// answers it wrongly. The model can put an image under the acceptance
		// section on its own, and the criteria recovery above now does it
		// routinely; either way, diffing `description` alone reports a key that
		// is still present as missing, re-signs it, and appends a SECOND copy
		// under a synthesized `## Attachments` block — with a warn log claiming
		// a drop that never happened.
		const oldKeys = extractStoryMediaKeysFromContent(
			combineCleanSpec(story.description, story.acceptanceCriteria),
		);
		const newKeyArray = extractStoryMediaKeysFromContent(
			combineCleanSpec(enhanced.description, enhanced.acceptanceCriteria),
		);
		const newKeys = new Set(newKeyArray);
		const droppedKeys = oldKeys.filter((k) => !newKeys.has(k));
		if (droppedKeys.length > 0) {
			const expectedPrefix = `story-media/${input.projectId}/${input.storyId}/`;
			const safeKeys: string[] = [];
			for (const key of droppedKeys) {
				if (key.startsWith(expectedPrefix)) {
					safeKeys.push(key);
				} else {
					// Defense in depth — this should be impossible because
					// the keys were just extracted from `story.description`
					// which the tenant filter has already validated as
					// belonging to this story.
					logger.error(
						"[stage-transition] skipped key with unexpected prefix",
						{
							storyId: input.storyId,
							projectId: input.projectId,
							surface: "enhance-feature",
							key,
							expectedPrefix,
						},
					);
				}
			}
			if (safeKeys.length > 0) {
				const storageProvider = getStorageProvider();
				const bucket = config.storage.bucketNames.projectContexts;
				const signResults = await Promise.allSettled(
					safeKeys.map((key) =>
						storageProvider
							.getSignedUrl(key, { bucket, expiresIn: 3600 })
							.then((url) => ({ key, url })),
					),
				);
				const reinjected: { key: string; url: string }[] = [];
				signResults.forEach((result, idx) => {
					if (result.status === "fulfilled") {
						reinjected.push(result.value);
					} else {
						// Sign failure is logged but not fatal — the other
						// keys still reinject with valid URLs; the failed key
						// is skipped here, and the reload-time resolver
						// re-signs from the key on next mount regardless.
						logger.error(
							"[stage-transition] failed to sign dropped attachment",
							{
								storyId: input.storyId,
								projectId: input.projectId,
								surface: "enhance-feature",
								key: safeKeys[idx],
								err:
									result.reason instanceof Error
										? result.reason.message
										: String(result.reason),
							},
						);
					}
				});
				if (reinjected.length > 0) {
					const attachmentsSection = [
						"",
						"## Attachments",
						"",
						...reinjected.map(({ url }) => `![](${url})`),
					].join("\n");
					enhanced.description =
						(enhanced.description ?? "") + attachmentsSection;
					logReinjectedAttachments({
						storyId: input.storyId,
						projectId: input.projectId,
						surface: "enhance-feature",
						targetStage: null,
						draftingStage: story.draftingStage,
						droppedKeys: reinjected.map(({ key }) => key),
					});
				}
			}
		}

		// Position the canonical "View in Fabric" back-link at the visual end
		// of the card. `placeFabricBackLink` strips every prior occurrence in
		// both description and acceptanceCriteria (the LLM may have kept it
		// inline, dropped it, or duplicated it), then puts a single canonical
		// anchor at the end of acceptanceCriteria when AC is non-empty, else
		// at the end of description. Soft-fail like createStory: a missing
		// back-link must not fail the AI flow.
		try {
			const project = await db.project.findUnique({
				where: { id: input.projectId },
				select: { organizationId: true },
			});
			const fabricUrl = await buildFabricStoryUrl({
				projectId: input.projectId,
				storyId: input.storyId,
				organizationId: project?.organizationId,
			});
			const placed = placeFabricBackLink({
				description: enhanced.description,
				acceptanceCriteria: enhanced.acceptanceCriteria,
				fabricUrl,
			});
			enhanced.description = placed.description;
			enhanced.acceptanceCriteria =
				placed.acceptanceCriteria ?? undefined;
		} catch (e) {
			logger.warn(
				"[enhance-feature] Failed to re-place Fabric back-link",
				{
					error: e instanceof Error ? e.message : String(e),
					storyId: input.storyId,
				},
			);
		}

		const tenantContext = {
			userId: user.id,
			organizationId,
		};

		// Determine the next available version number to avoid collisions.
		// On repeated enhancements, story.version may already exist in the
		// FeatureVersion table, so always start from max(existing) + 1.
		const maxVersionRecord = await db.featureVersion.findFirst({
			where: { storyId: input.storyId },
			orderBy: { version: "desc" },
			select: { version: true },
		});
		const currentVersion = story.version ?? 1;
		const nextVersion =
			Math.max(currentVersion, maxVersionRecord?.version ?? 0) + 1;

		const stageLabel = effectiveStage.toLowerCase().replace(/_/g, " ");
		const beforeLabel = isCleanSpecRefresh
			? "Before Clean Spec refresh"
			: `Before ${stageLabel} enhancement`;
		const afterLabel = isCleanSpecRefresh
			? "Clean Spec refreshed"
			: `AI-enhanced to ${stageLabel}`;

		// Snapshot current content before AI enhancement
		await createFeatureVersion({
			storyId: input.storyId,
			version: nextVersion,
			description: story.description ?? null,
			acceptanceCriteria: story.acceptanceCriteria ?? null,
			draftingStage: story.draftingStage as FeatureDraftingStage,
			changeDescription: beforeLabel,
			changedBy: user.id,
			...tenantContext,
		});

		// Create version for the enhanced content
		const newVersion = nextVersion + 1;
		await createFeatureVersion({
			storyId: input.storyId,
			version: newVersion,
			description: enhanced.description,
			acceptanceCriteria: enhanced.acceptanceCriteria ?? null,
			draftingStage: effectiveStage,
			changeDescription: afterLabel,
			changedBy: user.id,
			changeSummary: enhanced.changeSummary,
			...tenantContext,
		});

		// Update content + stage + version together. In refresh mode `effectiveStage`
		// is the current stage, so the drafting stage is held steady.
		const updatedStory = await updateStory(
			input.storyId,
			input.projectId,
			{
				description: enhanced.description,
				acceptanceCriteria: enhanced.acceptanceCriteria ?? null,
				draftingStage: effectiveStage,
			},
			{
				lastEditedByName: user.name ?? null,
				lastEditedSource: "AI_MATURATION",
			},
		);

		// Same trigger as the two non-AI exits above: a successful enhance is
		// still a route to Ready for Dev.
		runInBackground(
			maybeAutoDraftOnStageChange({
				projectId: input.projectId,
				storyId: input.storyId,
				userId: user.id,
				previousStage: story.draftingStage,
				targetStage: effectiveStage,
			}),
		);

		// Increment version on the story
		await db.userStory.update({
			where: { id: input.storyId },
			data: { version: newVersion },
		});

		// Mark the Clean Spec as freshly (re)built by an AI/context path so the
		// editor's refresh control reflects genuine staleness (#2/#3).
		await setLastContextUpdateAt({
			userStoryId: input.storyId,
			projectId: input.projectId,
		});

		enqueuePmSync({
			itemId: input.storyId,
			itemType: "story",
			projectId: input.projectId,
			userId: user.id,
			triggerSource: "manual-edit",
		}).catch((err) => {
			logger.warn("enqueuePmSync failed", {
				storyId: input.storyId,
				err: err instanceof Error ? err.message : String(err),
			});
		});

		// Feature Maturation V2: questions are a product of a maturation run, not a
		// standalone scan. When the org has V2 enabled, extract the open questions
		// this enhance surfaced into structured Decision Log roots, deduped against
		// already-decided ones (extract-maturation-questions.ts). Awaited so the
		// editor-state refetch on enhance success shows them; strictly best-effort —
		// it must never fail the enhance.
		await extractQuestionsAfterEnhance({
			storyId: input.storyId,
			projectId: input.projectId,
			organizationId: organizationId ?? null,
			userId: user.id,
		});

		return {
			story: stripInternalStoryFields(updatedStory),
			aiEnhanced: true,
		};
	});

interface ExtractAfterEnhanceParams {
	storyId: string;
	projectId: string;
	/** `null` in personal context — V2 is always on for personal (#1797). */
	organizationId: string | null;
	userId: string;
}

/**
 * Run the V2 question-extraction pass over the freshly-enhanced doc. For an org,
 * still honor its `featureMaturationV2Enabled` kill-switch; personal has no org
 * row and is unconditionally enrolled in V2 (#1797). Best-effort: any failure
 * (flag read, model call) is logged and swallowed so it never fails the enhance
 * the PO asked for.
 */
async function extractQuestionsAfterEnhance({
	storyId,
	projectId,
	organizationId,
	userId,
}: ExtractAfterEnhanceParams): Promise<void> {
	try {
		if (organizationId) {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { featureMaturationV2Enabled: true },
			});
			if (!org?.featureMaturationV2Enabled) {
				return;
			}
		}
		const feature = await getFeatureMaturationState({
			userStoryId: storyId,
			projectId,
		});
		if (!feature) {
			return;
		}
		await extractMaturationQuestions({
			feature,
			tenantFilter: { organizationId, userId },
		});
	} catch (err) {
		logger.warn("[maturation] post-enhance question extraction failed", {
			storyId,
			err: err instanceof Error ? err.message : String(err),
		});
	}
}
