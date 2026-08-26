/**
 * Type-aware, structure-preserving re-analysis of an existing work-item body.
 *
 * This is the heart of "AI Update preserves existing structure and makes
 * targeted edits". Given an existing work item (its kind + full body) and new
 * information, it resolves the kind-appropriate re-analysis prompt
 * (`bug_reanalysis` for BUG, `feature_reanalysis` for FEATURE), feeds the FULL
 * existing body plus the new info, and returns a merged body that keeps the
 * existing sections and applies only targeted edits.
 *
 * SAFETY (user decision: "Safe-hold + flag"): this function never throws and
 * never returns a destructive rewrite. If the prompt isn't bound, the model
 * errors, or the output would drop the body's canonical structure, it returns
 * `fallbackUsed: true` with the ORIGINAL body unchanged. The caller keeps the
 * existing body and surfaces/logs the fallback — AI Update never silently
 * destroys carefully-structured content.
 *
 * Lives in `@repo/temporal/src/lib` (like `create-story-from-proposal.ts`) so
 * both temporal activities (the AI Update / AI Backlog apply pipeline) and, if
 * ever needed, `@repo/api` procedures can call it without a dependency cycle.
 */

import { getLockedAttachmentRulesClause } from "@repo/agent-prompts";
import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
// Imported from the SUBPATH (not @repo/ai root) so it stays UNMOCKED in tests
// that mock the @repo/ai root module without spreading real exports (uniform
// rule across the budget sites; see update-with-context-core.ts).
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { getBoundPromptForAgent, type StoryKind } from "@repo/database";
import { logger } from "@repo/logs";
import {
	decodeMarkdownQuoteEntities,
	renderTemplate,
	type TemplateFormat,
} from "@repo/utils";
import { z } from "zod";
import {
	detectDestructiveRewrite,
	extractSectionBody,
	spliceSectionBody,
} from "./structure-guards";

const ORIGINAL_DESCRIPTION_HEADER =
	"Original Description from User (Do Not Modify)";

/** Agent keys the re-analysis prompts are bound under (see seed-prompts-only.ts). */
const REANALYZER_AGENT_KEY: Record<StoryKind, string> = {
	BUG: "bug_reanalyzer",
	FEATURE: "feature_reanalyzer",
};

const ReanalyzedBugSchema = z.object({
	needsMoreInfo: z
		.boolean()
		.describe(
			"True only when the report is still too ambiguous to act on after the new info; false otherwise.",
		),
	markdown: z
		.string()
		.describe(
			"Full updated bug card markdown. MUST preserve the 'Original Description from User (Do Not Modify)' section exactly and keep all bug sections that still apply.",
		),
});

const ReanalyzedFeatureSchema = z.object({
	description: z
		.string()
		.describe(
			"Full updated feature description markdown. Preserve the existing section layout; apply only targeted edits warranted by the new info.",
		),
	acceptanceCriteria: z
		.string()
		.optional()
		.describe(
			"Updated acceptance criteria markdown. Preserve existing criteria; only add/adjust what the new info warrants. Omit to leave acceptance criteria unchanged.",
		),
});

export interface ReanalyzeBodyByKindParams {
	kind: StoryKind;
	title: string;
	identifier?: string;
	/** The item's current description (full body) — preserved structure source. */
	existingDescription: string;
	/** The item's current acceptance criteria (features keep this separate). */
	existingAcceptanceCriteria?: string | null;
	/** The new information to fold in (analyzer's proposed change + reasoning, or a thread excerpt). */
	newInfo: string;
	/** Optional connected/RAG context to help the merge answer questions. */
	connectedContext?: string;
	userId: string;
	organizationId: string | null | undefined;
	projectId: string;
}

export interface ReanalyzeBodyByKindResult {
	/** The merged description to persist. On fallback, equals the existing description. */
	description: string;
	/**
	 * The merged acceptance criteria. `undefined` means "leave acceptance
	 * criteria unchanged" (no edit proposed / not applicable to bugs).
	 */
	acceptanceCriteria?: string;
	/** Bug-only triage flag; `undefined` for features. */
	needsMoreInfo?: boolean;
	/** True when no safe targeted edit could be produced — caller must safe-hold. */
	fallbackUsed: boolean;
	/** Machine reason for the fallback (logs/audit only). */
	fallbackReason?: string;
}

function fallback(
	params: ReanalyzeBodyByKindParams,
	reason: string,
): ReanalyzeBodyByKindResult {
	return {
		description: params.existingDescription,
		acceptanceCriteria: undefined,
		needsMoreInfo: undefined,
		fallbackUsed: true,
		fallbackReason: reason,
	};
}

/**
 * Re-analyze an existing work-item body with new info, preserving structure.
 * Never throws; returns `fallbackUsed: true` (with the original body) on any
 * problem so the caller can safe-hold.
 */
export async function reanalyzeBodyByKind(
	params: ReanalyzeBodyByKindParams,
): Promise<ReanalyzeBodyByKindResult> {
	const {
		kind,
		title,
		identifier,
		existingDescription,
		existingAcceptanceCriteria,
		newInfo,
		connectedContext,
		userId,
		organizationId,
		projectId,
	} = params;
	const orgId = organizationId ?? undefined;

	const boundPrompt = await getBoundPromptForAgent({
		agentName: REANALYZER_AGENT_KEY[kind],
		documentType: "DRAFT",
		storyKind: kind,
		userId,
		organizationId: orgId,
	});
	if (!boundPrompt?.version?.content) {
		// Prompt not seeded/bound (e.g. local before the prompts seed ran, or a
		// tenant without the binding). Safe-hold rather than overwrite.
		// Fizzy #2048 (R13): name the key that was missing. "Safe-holding" without
		// it says a binding is absent but not WHICH one, so the report that lands
		// later ("my bug came back feature-shaped") cannot be matched to the
		// tenant's missing binding without re-deriving the mapping by hand.
		logger.warn(
			"[reanalyzeBodyByKind] re-analysis prompt not bound; safe-holding existing body",
			{
				kind,
				projectId,
				agentName: REANALYZER_AGENT_KEY[kind],
				documentType: "DRAFT",
				outcome: "miss",
				promptSource: "bound",
			},
		);
		return fallback(params, "prompt_not_bound");
	}

	const variables =
		kind === "BUG"
			? {
					bug_title: title,
					bug_id_or_link: identifier ?? "",
					existing_bug_markdown: existingDescription,
					new_info_from_user_or_thread: newInfo,
					connected_context_items: connectedContext ?? "",
				}
			: {
					feature_title: title,
					feature_id_or_link: identifier ?? "",
					existing_feature_markdown: existingDescription,
					existing_acceptance_criteria:
						existingAcceptanceCriteria ?? "",
					new_info_from_user_or_thread: newInfo,
					connected_context_items: connectedContext ?? "",
				};

	const rendered = await renderTemplate({
		format: boundPrompt.format as TemplateFormat,
		template: boundPrompt.version.content,
		variables,
	});
	if (rendered.error) {
		logger.warn(
			"[reanalyzeBodyByKind] prompt render error; using raw body",
			{
				kind,
				projectId,
				error: rendered.error,
			},
		);
	}

	// Fizzy #1767 Stage 4: append the project's function-tag role-composition
	// clause (flag-gated, self-authorizing — see getProjectFunctionTagClause)
	// so the model knows who's on the project and in what capacity. `projectId`
	// is required here; guard kept for uniformity with the other splice sites.
	const roleClause = projectId
		? await getProjectFunctionTagClause({
				projectId,
				requesterUserId: userId,
				surface: "reanalyze-body",
			})
		: "";

	// FR-25: append the shared locked-attachment
	// rule so structure-preserving AI Update (rewrite/extend) never claims to
	// have analysed an attachment or fabricates its contents. Appended in code
	// so it holds regardless of the org-editable bound re-analysis prompt.
	// No-op today (no attachment metadata reaches AI context).
	const promptWithRules = `${rendered.rendered}\n\n${getLockedAttachmentRulesClause()}${roleClause ? `\n\n${roleClause}` : ""}`;

	try {
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{ userId, organizationId: orgId },
		);
		const startedAt = Date.now();

		if (kind === "BUG") {
			// Structure-preserving rewrite returns the FULL updated body, so output
			// scales with the existing body — scaled mode. Without an explicit
			// budget Databricks/Anthropic-direct truncate at their injected defaults
			// (8,192 / 4,096); `undefined` leaves other providers on SDK defaults.
			const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
				inputChars: existingDescription.length,
				promptChars: promptWithRules.length,
			});
			const { object, usage } = await generateObject({
				model,
				schema: ReanalyzedBugSchema,
				prompt: promptWithRules,
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			});
			trackUsage();
			logModelUsageAsync({
				context: { userId, organizationId: orgId },
				metadata,
				taskType: "COMPLEX",
				usage,
				latencyMs: Date.now() - startedAt,
				projectId,
			});

			let finalMarkdown = object.markdown;

			// Preserve "Original Description from User (Do Not Modify)" verbatim
			// (mirrors the Re-evaluate Bug server-side guard). If the model
			// dropped the section entirely, that's destructive → safe-hold.
			const originalBody = extractSectionBody(
				existingDescription,
				ORIGINAL_DESCRIPTION_HEADER,
			);
			if (originalBody !== null) {
				const llmBody = extractSectionBody(
					finalMarkdown,
					ORIGINAL_DESCRIPTION_HEADER,
				);
				if (llmBody === null) {
					logger.warn(
						"[reanalyzeBodyByKind] BUG re-analysis dropped Original Description; safe-holding",
						{ projectId, identifier },
					);
					return fallback(params, "original_description_dropped");
				}
				if (llmBody !== originalBody) {
					finalMarkdown = spliceSectionBody(
						finalMarkdown,
						ORIGINAL_DESCRIPTION_HEADER,
						originalBody,
					);
				}
			}

			const destructive = detectDestructiveRewrite({
				existing: existingDescription,
				candidate: finalMarkdown,
				kind: "BUG",
			});
			if (destructive.destructive) {
				logger.warn(
					"[reanalyzeBodyByKind] BUG re-analysis was destructive; safe-holding",
					{ projectId, identifier, reason: destructive.reason },
				);
				return fallback(params, destructive.reason ?? "destructive");
			}

			return {
				// Models routinely HTML-escape apostrophes and quotes into what
				// is a MARKDOWN body, where an entity is literal text, and
				// escape the ampersand of an entity they were shown — so the
				// damage compounds once per pass. Decoding here is the choke
				// point every merged body flows through.
				description: decodeMarkdownQuoteEntities(finalMarkdown),
				acceptanceCriteria: undefined,
				needsMoreInfo: object.needsMoreInfo,
				fallbackUsed: false,
			};
		}

		// FEATURE
		// Scaled mode: the rewrite returns the full description (and optionally
		// acceptance criteria), so output tracks the existing body being edited.
		const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
			inputChars:
				existingDescription.length +
				(existingAcceptanceCriteria?.length ?? 0),
			promptChars: promptWithRules.length,
		});
		const { object, usage } = await generateObject({
			model,
			schema: ReanalyzedFeatureSchema,
			prompt: promptWithRules,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});
		trackUsage();
		logModelUsageAsync({
			context: { userId, organizationId: orgId },
			metadata,
			taskType: "COMPLEX",
			usage,
			latencyMs: Date.now() - startedAt,
			projectId,
		});

		const destructive = detectDestructiveRewrite({
			existing: existingDescription,
			candidate: object.description,
			kind: "FEATURE",
		});
		if (destructive.destructive) {
			logger.warn(
				"[reanalyzeBodyByKind] FEATURE re-analysis was destructive; safe-holding",
				{ projectId, identifier, reason: destructive.reason },
			);
			return fallback(params, destructive.reason ?? "destructive");
		}

		// Never wipe non-empty acceptance criteria: if the model returned blank
		// AC while the item had AC, leave AC unchanged (omit it from the result).
		const trimmedAc = object.acceptanceCriteria?.trim();
		const acceptanceCriteria =
			trimmedAc && trimmedAc.length > 0
				? object.acceptanceCriteria
				: undefined;

		return {
			// See the BUG branch above: markdown bodies must not carry HTML
			// entities, and the escaping compounds on every enrichment.
			description: decodeMarkdownQuoteEntities(object.description),
			acceptanceCriteria: acceptanceCriteria
				? decodeMarkdownQuoteEntities(acceptanceCriteria)
				: acceptanceCriteria,
			needsMoreInfo: undefined,
			fallbackUsed: false,
		};
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			logger.warn(
				"[reanalyzeBodyByKind] AI provider not configured; safe-holding",
				{ kind, projectId },
			);
			return fallback(params, "ai_not_configured");
		}
		logger.error("[reanalyzeBodyByKind] re-analysis failed; safe-holding", {
			kind,
			projectId,
			error: error instanceof Error ? error.message : String(error),
		});
		return fallback(params, "llm_error");
	}
}
