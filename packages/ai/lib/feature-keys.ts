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
	/**
	 * Glossy Version Export: fact/structural guard passes, visual copy and
	 * spec generation, and per-visual regeneration during review (Fizzy #2589).
	 */
	"glossy-edition",
	/**
	 * Proposal artifact visuals: detection and spec extraction for the
	 * visuals the coordinated Proposal job writes into the Main document
	 * (Fizzy #2801).
	 */
	"proposal-visuals",
	/**
	 * Proposal artifact Internal Analysis: the review of a saved Main
	 * document that only the owning organization's members read (Fizzy #2801).
	 */
	"proposal-analysis",
	/**
	 * Parlume meeting agent: every spoken turn (built-in or custom agent),
	 * speech synthesis, post-meeting notes, and the meeting-provider bot time
	 * recorded as an invocation-marker row at finalization. `conversationId`
	 * carries the Parlume session id so spend rolls up per meeting.
	 */
	"parlume",
	/**
	 * The Test button on a ChatGPT plan's settings card (Fizzy #2770): one
	 * tiny request that checks the plan answers. Tagged so the window's
	 * "Used by" line names it rather than counting it as someone's work.
	 */
	"chatgpt-plan-test",
	/**
	 * Code index embeddings: the repository files a project's code index
	 * chunks and embeds (Fizzy #2770). Tagged so AI Usage attributes that
	 * spend to the project instead of an untagged embedding bucket.
	 */
	"code-index",
	/**
	 * The `fabric_text_to_speech` tool, wherever it runs: chat, agent turns
	 * and orchestrator workflow steps.
	 */
	"text-to-speech",
	/** Audio and video transcription. */
	"transcription",
	/** Delivery-track classification of a project's stories. */
	"delivery-track",
	/** Document quality scoring (document evaluation metrics). */
	"document-quality",
	/** Story kind classification (feature, bug, ...) of a new work item. */
	"story-classification",
	/**
	 * The `agent-task` workflow step: an unattended agent turn run by a
	 * published workflow, usually on a schedule. Its own key so scheduled agent
	 * spend is not counted as chat.
	 */
	"scheduled-agent-task",
] as const;

export type AiFeatureKey = (typeof AI_FEATURE_KEYS)[number];

/**
 * Out-of-process agents whose model calls all serve one feature. Their usage
 * rows arrive with an `agentId` (sometimes suffixed, e.g.
 * `project_document_generator:budget_gate`) but no feature key.
 */
const AGENT_FEATURE_KEYS: ReadonlyMap<string, AiFeatureKey> = new Map([
	["project_document_generator", "document-generation"],
	["backlog_updater", "backlog-update"],
]);

/** The feature an agent's usage row belongs to, judged by its agent id. */
export function featureKeyForAgentId(
	agentId: string | null | undefined,
): AiFeatureKey | undefined {
	if (!agentId) {
		return undefined;
	}
	const [baseAgentId] = agentId.split(":");
	return AGENT_FEATURE_KEYS.get(baseAgentId);
}
