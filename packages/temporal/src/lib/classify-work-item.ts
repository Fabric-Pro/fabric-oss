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
 *   - Uses the optional typed decision model only for a high-confidence BUG /
 *     FEATURE choice, then otherwise calls generateObject with a Zod schema
 *     matching F-171's exact output shape.
 *   - On ANY failure path (LLM unconfigured, no prompt bound, schema mismatch,
 *     network error), returns the safe fallback: kind=FEATURE, confidence=Low,
 *     fallback_used=true, rationale="classifier_error". Silent corruption of
 *     `kind` is the worst-case bug per F-171's NFR observability rule, so we
 *     ALWAYS log fallback_used=true so it surfaces in audit.
 */

import {
	AIProviderNotConfiguredError,
	experimental_evaluate,
	generateObject,
	getAIDecisionModelWithMetadata,
	getAIModelWithMetadata,
} from "@repo/ai";
import {
	getBoundPromptForAgent,
	type ReporterSource,
	type StoryKind,
	type StorySource,
} from "@repo/database";
import { logger } from "@repo/logs";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
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

const DECISION_TIMEOUT_MS = 10_000;
const DECISION_MAX_RETRIES = 1;
// This is a routing policy, not a claim that provider probabilities are
// calibrated. Until labeled Fabric work-item data calibrates it, only a very
// confident typed choice can skip the existing language classifier.
const DECISION_CONFIDENCE_THRESHOLD = 0.9;

function isConfidentDecision(
	result: Awaited<ReturnType<typeof experimental_evaluate>>,
): ClassifierOutput | null {
	const answer = (result as { answers?: Record<string, unknown> }).answers
		?.workItemKind;
	if (!answer || typeof answer !== "object") {
		return null;
	}

	const { type, choice, probabilities } = answer as {
		type?: unknown;
		choice?: unknown;
		probabilities?: unknown;
	};
	if (
		type !== "choice" ||
		(choice !== "BUG" && choice !== "FEATURE") ||
		!probabilities ||
		typeof probabilities !== "object"
	) {
		return null;
	}

	const probability = (probabilities as Record<string, unknown>)[choice];
	if (
		typeof probability !== "number" ||
		!Number.isFinite(probability) ||
		probability < DECISION_CONFIDENCE_THRESHOLD ||
		probability > 1
	) {
		return null;
	}

	return {
		kind: choice,
		confidence: "High",
		fallback_used: false,
		// Typed evaluations return a choice and probability, not generated
		// evidence. Keep these fields deliberately empty rather than inventing
		// signals or a model rationale.
		primary_signals: [],
		rationale: "decision_evaluation",
	};
}

function rethrowUsageLimit(error: unknown): void {
	if (error instanceof AiUsageLimitExceededError) {
		throw error;
	}
}

export async function classifyWorkItem(
	input: ClassifyWorkItemInput,
): Promise<ClassifierOutput> {
	const orgId = input.organizationId ?? undefined;

	let boundPrompt: Awaited<ReturnType<typeof getBoundPromptForAgent>>;
	try {
		// `bug_classifier` is bound under a dedicated agent key
		// ("work_item_classifier") in the seed so it doesn't collide with the
		// existing `project_document_generator_default` binding at
		// (project_document_generator, GENERAL, null).
		boundPrompt = await getBoundPromptForAgent({
			agentName: "work_item_classifier",
			documentType: "GENERAL",
			storyKind: null,
			userId: input.userId,
			organizationId: orgId,
		});
	} catch (error) {
		logger.error("[classify-work-item] prompt resolution failed", {
			error: error instanceof Error ? error.message : String(error),
			projectId: input.projectId,
		});
		return SAFE_FALLBACK;
	}

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

	// The classifier prompt is a HANDLEBARS/markdown body containing both the
	// SYSTEM and USER sections. Render with the reporter inputs so the LLM
	// sees the user's text in the right slot.
	let rendered: Awaited<ReturnType<typeof renderTemplate>>;
	try {
		rendered = await renderTemplate({
			format: boundPrompt.format as TemplateFormat,
			template: boundPrompt.version.content,
			variables: {
				reporter_text: input.reporterText,
				creation_source: input.creationSource ?? "Manual",
				additional_context: input.additionalContext ?? "",
			},
		});
	} catch (error) {
		logger.error("[classify-work-item] prompt render failed", {
			error: error instanceof Error ? error.message : String(error),
			projectId: input.projectId,
		});
		return SAFE_FALLBACK;
	}
	if (rendered.error) {
		logger.warn(
			"[classify-work-item] prompt render failed; using raw body",
			{
				error: rendered.error,
			},
		);
	}

	// Decision evaluation is optional. Organizations without an organization-owned
	// Vercel Gateway decision model continue through the language classifier.
	try {
		const decisionModel = await getAIDecisionModelWithMetadata({
			userId: input.userId,
			organizationId: orgId,
			projectId: input.projectId,
		});
		const decision = await experimental_evaluate({
			model: decisionModel.model,
			state: {
				classifierPolicy: rendered.rendered,
				reporterText: input.reporterText,
				creationSource: input.creationSource ?? "Manual",
				additionalContext: input.additionalContext ?? "",
			},
			questions: {
				workItemKind: {
					type: "choice",
					instructions:
						"Apply classifierPolicy to the supplied work item. Choose BUG only for an existing behavior that is incorrect; choose FEATURE for a requested or new capability.",
					criteria: {
						BUG: "An existing behavior is broken, regressed, or produces an incorrect result.",
						FEATURE:
							"A requested capability, enhancement, or ambiguous work item.",
					},
				},
			},
			maxRetries: DECISION_MAX_RETRIES,
			abortSignal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
		});
		// A completed evaluation used the organization provider even if the
		// answer is too uncertain for the fast path, so update last-used before
		// inspecting the result.
		decisionModel.trackUsage();
		const confidentDecision = isConfidentDecision(decision);
		if (confidentDecision) {
			logger.info("[classify-work-item] decision evaluation returned", {
				promptKey: "bug_classifier",
				kind: confidentDecision.kind,
				confidence: confidentDecision.confidence,
				projectId: input.projectId,
			});
			return confidentDecision;
		}
		logger.warn(
			"[classify-work-item] decision evaluation was uncertain or malformed; using language classifier",
			{ projectId: input.projectId },
		);
	} catch (error) {
		rethrowUsageLimit(error);
		logger.warn(
			"[classify-work-item] decision evaluation unavailable; using language classifier",
			{
				error: error instanceof Error ? error.message : String(error),
				projectId: input.projectId,
			},
		);
	}

	let modelResolution: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
	try {
		modelResolution = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{
				userId: input.userId,
				organizationId: orgId,
				projectId: input.projectId,
			},
		);
	} catch (error) {
		rethrowUsageLimit(error);
		if (error instanceof AIProviderNotConfiguredError) {
			logger.warn(
				"[classify-work-item] AI provider not configured; falling back to FEATURE",
				{ projectId: input.projectId },
			);
		} else {
			logger.error(
				"[classify-work-item] language model resolution failed",
				{
					error:
						error instanceof Error ? error.message : String(error),
					projectId: input.projectId,
				},
			);
		}
		return SAFE_FALLBACK;
	}

	try {
		const { model, trackUsage } = modelResolution;

		const { object } = await generateObject({
			model,
			schema: ClassifierOutputSchema,
			prompt: rendered.rendered,
		});

		trackUsage();

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
		rethrowUsageLimit(error);
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
