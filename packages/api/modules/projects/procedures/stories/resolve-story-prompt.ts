/**
 * Resolves the prompt a work item's detail-view action should run.
 *
 * Takes the WORK ITEM — never a kind, never an agent name. Loads the stored
 * row, derives the agent from `story.kind`, resolves the binding, and returns
 * the prompt text the caller posts into the agent thread, plus the kind the
 * server decided and its lowercase display word so the reviewer-facing message
 * and the template cannot disagree.
 *
 * Why the caller may not supply the kind: see `clean-spec-agent-for-kind.ts`,
 * and "Work item kind" in CONCEPTS.md.
 *
 * Nothing bound is NOT an error: the caller keeps its existing "no prompt
 * configured" handling, and an absent binding never falls back to the other
 * kind's prompt (`getBoundPromptVersion` is exact-match on kind by contract).
 */

import { ORPCError } from "@orpc/client";
import {
	FeatureDraftingStageSchema,
	getBoundPromptForAgent,
	getPromptById,
	getStoryById,
	type StoryKind,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	CLEAN_SPEC_DOCUMENT_TYPE,
	cleanSpecAgentForKind,
	resolveStoryKind,
	storyKindWord,
} from "@repo/temporal/clean-spec-agent-for-kind";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationMembership,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { validatePromptForKind } from "../../lib/validate-prompt-for-kind";

/** The agent the per-stage drafting prompts are bound under. */
const STAGE_PROMPT_AGENT = "project_document_generator";

export interface ResolveStoryPromptResult {
	/** False when nothing is bound — the caller surfaces its own message. */
	resolved: boolean;
	/** Raw prompt text, posted verbatim into the agent thread. */
	content: string | null;
	/** Catalog key of the prompt that was resolved, for logging and support. */
	promptKey: string | null;
	/** Where it came from: an explicit choice, or the kind-scoped binding. */
	source: "explicitPrompt" | "bound" | null;
	/** The kind the SERVER read off the stored row — not what the caller thinks. */
	kind: StoryKind;
	/** Lowercase display word for that same kind. */
	kindWord: "bug" | "feature";
}

export const resolveStoryPromptProcedure = tenantProtectedProcedure
	// STORY_UPDATE, not PROJECT_READ. This returns prompt-catalog text, and the
	// only reason to ask for it is to drive an AI rewrite of the work item — the
	// same bar the sibling `resolve-*` procedures set. PROJECT_READ would be
	// looser than the endpoint this replaces: `prompts.agents.bound` required an
	// org-level PROMPT_READ, which a project-scoped Viewer or Commenter does not
	// hold (`VIEWER_PROJECT_PERMISSIONS` carries PROJECT_READ and neither of the
	// other two), so gating on PROJECT_READ would hand catalog content to roles
	// that could not previously read it.
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/resolve-prompt",
		tags: ["Projects", "Features"],
		summary: "Resolve the prompt for a work item action",
		description:
			"Returns the prompt a detail-view AI action should run, chosen from the work item's stored kind. The caller supplies no kind and no agent name.",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			/**
			 * Present for a stage-transition Enhance — resolves the per-stage
			 * drafting prompt for the stored kind. Absent means the Clean Spec
			 * refresh, which resolves the kind's single Clean Spec prompt.
			 */
			targetStage: FeatureDraftingStageSchema.optional(),
			/**
			 * A prompt the reviewer picked by hand. Still resolved server-side so
			 * the choice is visible to the server, and refused when it is bound
			 * to the other kind — naming a prompt is a supported affordance,
			 * naming the other kind's prompt is the bypass this closes.
			 */
			promptId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }): Promise<ResolveStoryPromptResult> => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		// `resolveOrganizationId` returns the caller-supplied id VERBATIM; it
		// performs no membership check. Prompt records and their bindings are
		// tenant-scoped, so without this check the procedure would hand a caller
		// another tenant's customized prompt text. Same guard, same placement as
		// the maturation enhance procedure.
		if (organizationId) {
			await requireOrganizationMembership(organizationId, user.id);
		}

		const story = await getStoryById(input.storyId, input.projectId);
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Work item not found",
			});
		}

		// The only kind that matters. Read here, from the stored row, at the
		// moment the action runs (#2048 R1/R2/R4).
		const kind = resolveStoryKind(story.kind);
		const kindWord = storyKindWord(kind);
		const unresolved: ResolveStoryPromptResult = {
			resolved: false,
			content: null,
			promptKey: null,
			source: null,
			kind,
			kindWord,
		};

		// The document type this action's prompts are bound at: the target stage
		// for a stage-transition Enhance, CLEAN_SPEC for the refresh. Same split
		// the bound lookup below makes — the kind guard has to ask about the
		// document type the reviewer's prompt list was built from.
		const promptDocumentType =
			input.targetStage ?? CLEAN_SPEC_DOCUMENT_TYPE;

		/**
		 * Fizzy #2048 (R12, R13): every resolution says which template ran, for
		 * which kind, and — the part that matters when a report comes in — whether
		 * it was a catalog hit or a miss. A miss is the case that used to be
		 * invisible: the exact-match binding lookup has no cross-kind fallback, so
		 * an unbound kind produces no prompt rather than the wrong one, and without
		 * this line that difference never reached anyone.
		 *
		 * Keys and kinds only. Never the resolved content — the sibling lines in
		 * `prompts.agents.bound` and `enhanceFeature` omit prompt bodies for the
		 * same reason, and prompt text is tenant-authored.
		 */
		const logResolution = (
			outcome: "hit" | "miss" | "refused",
			detail: { promptKey: string | null; promptSource: string | null },
		) => {
			logger.info("[stories.resolvePrompt] resolved", {
				projectId: input.projectId,
				storyId: input.storyId,
				entryPoint: input.promptId
					? "explicitPrompt"
					: input.targetStage
						? "stageTransition"
						: "cleanSpecRefresh",
				storyKind: kind,
				documentType: promptDocumentType,
				outcome,
				...detail,
			});
		};

		if (input.promptId) {
			const prompt = await getPromptById(input.promptId, {
				userId: user.id,
				organizationId,
			});
			const content = prompt?.versions?.[0]?.content;
			// `prompt` is repeated in the guard so it narrows for the guard call
			// and the return below; the empty-content check alone does not.
			if (!prompt || !content?.trim()) {
				logResolution("miss", {
					promptKey: prompt?.key ?? null,
					promptSource: "explicitPrompt",
				});
				return unresolved;
			}
			// A caller may name a prompt; it may not name one scoped to the other
			// kind (#2048 R3). This refuses rather than silently re-resolving, and
			// refuses a prompt with no binding at this action's document type
			// rather than reading that absence as "kind-agnostic".
			try {
				await validatePromptForKind({
					promptId: input.promptId,
					promptLabel: prompt.name || prompt.key,
					kind,
					documentType: promptDocumentType,
					userId: user.id,
					organizationId,
				});
			} catch (refusal) {
				// The one outcome the guard exists to produce, and the only one
				// the hit/miss pair cannot express. Without this line a support
				// question about a rejected prompt has nothing to match on.
				logResolution("refused", {
					promptKey: prompt.key,
					promptSource: "explicitPrompt",
				});
				throw refusal;
			}
			logResolution("hit", {
				promptKey: prompt.key,
				promptSource: "explicitPrompt",
			});
			return {
				resolved: true,
				content,
				promptKey: prompt.key,
				source: "explicitPrompt",
				kind,
				kindWord,
			};
		}

		// A target stage means the per-stage drafting prompt; no stage means the
		// Clean Spec refresh. Both are scoped by the stored kind, so bugs and
		// features never pick each other's prompt at a shared stage.
		const boundPrompt = await getBoundPromptForAgent({
			agentName: input.targetStage
				? STAGE_PROMPT_AGENT
				: cleanSpecAgentForKind(kind),
			documentType: promptDocumentType,
			storyKind: kind,
			userId: user.id,
			organizationId,
		});
		const boundContent = boundPrompt?.version?.content;
		if (!boundPrompt || !boundContent?.trim()) {
			// Safe hold. No cross-kind substitution happens here and none happens
			// below it — the resolver is exact-match on kind by contract.
			logResolution("miss", { promptKey: null, promptSource: "bound" });
			return unresolved;
		}

		logResolution("hit", {
			promptKey: boundPrompt.key,
			promptSource: "bound",
		});
		return {
			resolved: true,
			content: boundContent,
			promptKey: boundPrompt.key,
			source: "bound",
			kind,
			kindWord,
		};
	});
