/**
 * F-171 Work Item Classifier
 *
 * Pre-creation dispatcher that decides whether a user's input describes a BUG
 * or a FEATURE. Runs inside `createStoryFromProposal` before the bug or
 * feature creation prompt is selected. Every creation path (manual UI, Slack,
 * Teams, AI Update, custom agents) funnels through `createStoryFromProposal`,
 * so this single helper covers REQ-1 / REQ-2 / REQ-22 for all of them — no
 * per-agent prompt updates required.
 *
 * Contract:
 *   - Resolves the `bug_classifier` SYSTEM prompt via getBoundPromptForAgent
 *     under the dedicated `work_item_classifier` agent key.
 *   - Renders the prompt's USER TEMPLATE with the reporter's text + optional
 *     creation_source / additional_context (per the spec artifact).
 *   - Calls generateObject with a Zod schema matching F-171's exact output
 *     shape: { kind, confidence, fallback_used, primary_signals, rationale }.
 *   - On ANY failure path (LLM unconfigured, no prompt bound, schema mismatch,
 *     network error), returns the safe fallback: kind=FEATURE, confidence=Low,
 *     fallback_used=true, rationale="classifier_error". Silent corruption of
 *     `kind` is the worst-case bug per F-171's NFR observability rule, so we
 *     ALWAYS log fallback_used=true so it surfaces in audit.
 */

import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import {
	getBoundPromptForAgent,
	type ReporterSource,
	type StoryKind,
	type StorySource,
} from "@repo/database";
import { logger } from "@repo/logs";
import { renderTemplate, type TemplateFormat } from "@repo/utils";
import { z } from "zod";

const ClassifierOutputSchema = z.object({
	kind: z.enum(["BUG", "FEATURE"]),
	confidence: z.enum(["High", "Medium", "Low"]),
	fallback_used: z.boolean(),
	primary_signals: z.array(z.string()),
	rationale: z.string(),
});

export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

export interface ClassifyWorkItemInput {
	reporterText: string;
	// Origin label the classifier prompt renders into the `creation_source`
	// slot. Restricted to the two enum types that legitimately produce a value
	// here (ReporterSource from F-171 reporter tracking, StorySource from the
	// older story-origin enum) — both are DB enums, so callers can't smuggle
	// arbitrary text into the LLM prompt.
	creationSource?: ReporterSource | StorySource | null;
	additionalContext?: string;
	userId: string;
	organizationId?: string | null;
	projectId?: string;
}

const SAFE_FALLBACK: ClassifierOutput = {
	kind: "FEATURE",
	confidence: "Low",
	fallback_used: true,
	primary_signals: [],
	rationale: "classifier_error",
};

export async function classifyWorkItem(
	input: ClassifyWorkItemInput,
): Promise<ClassifierOutput> {
	const orgId = input.organizationId ?? undefined;

	// Resolve the bound prompt and the AI model in parallel — they share no
	// data dependency, and each is a DB-bound round-trip. Saves ~10–15ms on the
	// hot path of every story creation.
	// `bug_classifier` is bound under a dedicated agent key
	// ("work_item_classifier") in the seed so it doesn't collide with the
	// existing `project_document_generator_default` binding at
	// (project_document_generator, GENERAL, null).
	const [boundPrompt, modelResolution] = await Promise.all([
		getBoundPromptForAgent({
			agentName: "work_item_classifier",
			documentType: "GENERAL",
			storyKind: null,
			userId: input.userId,
			organizationId: orgId,
		}),
		getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{ userId: input.userId, organizationId: orgId },
		).catch((error: unknown) => {
			if (error instanceof AIProviderNotConfiguredError) {
				return null;
			}
			throw error;
		}),
	]);

	if (
		!boundPrompt?.version?.content ||
		boundPrompt.key !== "bug_classifier"
	) {
		// If the bug_classifier prompt isn't bound (e.g., environment hasn't
		// been seeded yet), fall back to FEATURE per REQ-22. The seed
		// installs this binding by default.
		logger.warn(
			"[classify-work-item] bug_classifier prompt not bound; falling back to FEATURE",
			{
				resolvedKey: boundPrompt?.key,
				userId: input.userId,
				organizationId: orgId,
			},
		);
		return SAFE_FALLBACK;
	}

	if (!modelResolution) {
		logger.warn(
			"[classify-work-item] AI provider not configured; falling back to FEATURE",
			{ projectId: input.projectId },
		);
		return SAFE_FALLBACK;
	}

	// The classifier prompt is a HANDLEBARS/markdown body containing both the
	// SYSTEM and USER sections. Render with the reporter inputs so the LLM
	// sees the user's text in the right slot.
	const rendered = await renderTemplate({
		format: boundPrompt.format as TemplateFormat,
		template: boundPrompt.version.content,
		variables: {
			reporter_text: input.reporterText,
			creation_source: input.creationSource ?? "Manual",
			additional_context: input.additionalContext ?? "",
		},
	});
	if (rendered.error) {
		logger.warn(
			"[classify-work-item] prompt render failed; using raw body",
			{
				error: rendered.error,
			},
		);
	}

	try {
		const { model, metadata, trackUsage } = modelResolution;

		const startedAt = Date.now();
		const { object, usage } = await generateObject({
			model,
			schema: ClassifierOutputSchema,
			prompt: rendered.rendered,
		});

		trackUsage();
		logModelUsageAsync({
			context: { userId: input.userId, organizationId: orgId },
			metadata,
			taskType: "SIMPLE",
			usage,
			latencyMs: Date.now() - startedAt,
			projectId: input.projectId,
		});

		logger.info("[classify-work-item] classifier returned", {
			promptKey: "bug_classifier",
			kind: object.kind,
			confidence: object.confidence,
			fallback_used: object.fallback_used,
			rationale: object.rationale,
			projectId: input.projectId,
		});

		// Defense-in-depth against an LLM that ignores its own rules.
		// The bug_classifier prompt's hard rule is: "If you are not confident,
		// default to FEATURE" and "Low confidence → fallback to FEATURE".
		// Some models report fallback_used=true / confidence=Low but still
		// emit kind=BUG anyway — never trust that combination. Reconcile to
		// FEATURE server-side so the contract holds regardless of model.
		if (
			object.kind === "BUG" &&
			(object.fallback_used === true || object.confidence === "Low")
		) {
			logger.warn(
				"[classify-work-item] reconciling: LLM returned BUG with fallback_used/Low confidence; overriding to FEATURE per F-171 REQ-22",
				{
					originalKind: object.kind,
					confidence: object.confidence,
					fallback_used: object.fallback_used,
					rationale: object.rationale,
					projectId: input.projectId,
				},
			);
			return {
				...object,
				kind: "FEATURE",
				fallback_used: true,
			};
		}

		return object;
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			logger.warn(
				"[classify-work-item] AI provider not configured; falling back to FEATURE",
				{ projectId: input.projectId },
			);
		} else {
			logger.error("[classify-work-item] classifier failed", {
				error: error instanceof Error ? error.message : String(error),
				projectId: input.projectId,
			});
		}
		return SAFE_FALLBACK;
	}
}

/**
 * Helper for callers that just want the `StoryKind` and want classifier errors
 * to be invisible. Equivalent to `(await classifyWorkItem(input)).kind`. Use
 * the full `classifyWorkItem` when you want to log confidence / signals.
 */
export async function classifyWorkItemKind(
	input: ClassifyWorkItemInput,
): Promise<StoryKind> {
	const result = await classifyWorkItem(input);
	return result.kind;
}
