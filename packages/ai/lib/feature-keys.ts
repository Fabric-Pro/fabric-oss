/**
 * Canonical feature keys for AI invocation tagging (Fizzy #2230, Phase 1).
 *
 * Every user-facing AI feature that tags its model calls picks one key from
 * this list and passes it as `featureKey` in the `AIOperationContext` given to
 * `getAIModel`/`getAIModelWithMetadata`. The key is persisted verbatim on each
 * `AiUsageLog` row, so renaming a key orphans its historical rows — treat the
 * strings as append-only.
 *
 * The DB column is a plain string on purpose: dashboards must tolerate keys
 * this build does not know yet (older/newer app versions write concurrently).
 */
export const AI_FEATURE_KEYS = [
	/** Feature maturation runs: question extraction, spec analysis. */
	"maturation",
	/** AI recommended answers for maturation questions. */
	"answer-recommendation",
	/** Clean Spec generation for features and bugs. */
	"clean-spec",
	/** AI Backlog Update: context analysis, proposal drafting, apply. */
	"backlog-update",
	/** Project document generation and refresh. */
	"document-generation",
	/** Story task generation. */
	"generate-tasks",
	/** Enhance feature action. */
	"enhance-feature",
	/** Story title regeneration. */
	"regenerate-title",
	/** Bug re-evaluation. */
	"bug-reevaluation",
	/** Duplicate story scan and merge proposals. */
	"duplicate-scan",
	/** Unified chat agents (Fabric AI, sidekick, orchestrator). */
	"chat-agent",
	/** Summary of how a nominated prompt differs from the current default. */
	"prompt-nomination-summary",
	/** Decision tagging metadata suggestions (type, duration, priority, owner). */
	"decision-tagging",
	/**
	 * Publishing Suite: topic suggestions, planning analysis, and every
	 * generated content draft (short post, blog post, case study, stakeholder
	 * email).
	 *
	 * ONE key for the whole suite rather than one per content type. The
	 * question this feature is measured against — how many posts, how much
	 * revision, how many people publishing — is asked of the suite, and
	 * `getAiOutcomeBreakdown` groups by `featureKey` alone, so four keys would
	 * fragment the headline number into four the dashboard cannot add up.
	 * The per-content-type split lives on `subjectType`, which is the axis
	 * `AiOutcomeEvent` already carries for exactly that purpose, and a new
	 * content type then costs a subject type rather than a registry entry the
	 * dashboards have to learn.
	 */
	"publishing-suite",
] as const;

export type AiFeatureKey = (typeof AI_FEATURE_KEYS)[number];
