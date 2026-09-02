/**
 * The canonical catalog of prompt actions — the things a prompt can be bound to.
 *
 * What a binding identifies is already in the data model: an agent
 * (`PromptBinding.targetKey`), the kind of output it produces (`documentType`),
 * and sometimes which kind of work item it is for (`storyKind`). What the model
 * has never carried is a human-readable name for any of it. That lived in two
 * hand-maintained copies inside the prompt components — one listing thirteen
 * agents, the other four — so which agents you could bind a prompt to depended
 * on which button you had clicked.
 *
 * Each agent DECLARES its actions as explicit `(documentType, storyKind)` pairs.
 * An earlier version inferred the kind instead: non-stage document types were
 * assumed never to be kind-scoped. The seeds disagree — `qa_analysis_generator`
 * binds QA_ANALYSIS for FEATURE, `context_update_instructions` binds
 * CONTEXT_UPDATE for both kinds, and `security_finding_ticket` binds DRAFT for
 * BUG only. An inference that is wrong for a third of the catalog is worse than
 * a table, so this is a table.
 *
 * Project-document labels are NOT restated here; they come from
 * `document-type-catalog`, which owns them product-wide. What this file owns is
 * the part that catalog cannot: the prompt-only document types
 * (`PromptBinding.documentType` is a plain String and stores both), and the
 * agents themselves.
 *
 * Kept free of imports from `@repo/database`: the web app renders this on the
 * client, and `@repo/database` depends on this package.
 */

import { documentTypeShortLabel } from "./document-type-catalog";
import { PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY } from "./publishing-planning-prompt";
import { PUBLISHING_SHORT_POST_AGENT_KEY } from "./publishing-short-post-prompt";

export type PromptStoryKind = "FEATURE" | "BUG" | null;

/**
 * Document types that exist only in the prompt layer.
 *
 * These share the `documentType` column with project document types but are not
 * members of the `ProjectDocumentType` enum — drafting stages, and the outputs
 * of agents that write something other than a project document.
 *
 * PASSIVE_ANALYSIS is deliberately absent: soft-deprecated per spec
 * 2026-05-19-remove-passive-analysis. Bindings that already reference it still
 * resolve; they just cannot be created.
 */
const PROMPT_DOCUMENT_LABELS: Record<string, string> = {
	// Work-item drafting stages
	PLACEHOLDER: "Placeholder",
	ACTIVE_ANALYSIS: "Active Analysis",
	SANITY_CHECK: "Sanity Check",
	DRAFT: "Draft",
	// Other prompt-layer outputs
	CLEAN_SPEC: "Clean Spec",
	CONTEXT_UPDATE: "Context Update",
	ANSWER_RECOMMENDATIONS: "Answer Recommendations",
	QA_ANALYSIS: "QA Analysis",
	STORY_BREAKDOWN: "Story Breakdown",
	TASK_PLAN: "Task Plan",
	CODE_REVIEW: "Code Review",
	ADR: "Architecture Decision Record",
	RUNBOOK: "Runbook",
	// Clarifying-question depth tiers
	MINIMAL: "Minimal",
	BALANCED: "Balanced",
	THOROUGH: "Thorough",
};

/**
 * The display label for anything `PromptBinding.documentType` can hold.
 *
 * Prompt-layer types first, then the product-wide document catalog. A value in
 * neither de-underscores rather than throwing — a binding written before a type
 * was retired should still render something a human can read.
 */
export function promptDocumentTypeLabel(documentType: string): string {
	return (
		PROMPT_DOCUMENT_LABELS[documentType] ??
		documentTypeShortLabel(documentType)
	);
}

/**
 * Tier 1 of the catalog — the product area an action belongs to.
 *
 * These follow the areas the app already has rather than inventing a parallel
 * structure, so someone looking for "the prompt behind the thing I was just
 * doing" browses the same shape of the product they were browsing a moment ago.
 */
export const PROMPT_FEATURE_TYPES = {
	PROJECT_DOCUMENTS: {
		label: "Project Documents",
		description:
			"The documents Fabric writes for a project — PRDs, architecture, specs.",
	},
	ROADMAP: {
		label: "Roadmap",
		description:
			"Re-prioritising features and bugs across the roadmap's priority bands.",
	},
	WORK_ITEMS: {
		label: "Work Items",
		description:
			"Drafting, classifying and refining features and bugs as they mature.",
	},
	QUALITY: {
		label: "Quality & Testing",
		description:
			"Test-case drafting and revision, test-run analysis, and the QA lens on a pull request.",
	},
	SECURITY: {
		label: "Security & Accessibility",
		description:
			"Guidance and false-positive rubrics injected into the scanning agents.",
	},
	MEETINGS: {
		label: "Meetings & Intake",
		description:
			"Preparing meetings, and deciding where captured action items land.",
	},
	PUBLISHING: {
		label: "Publishing Suite",
		description:
			"Turning delivered work into publishable topics, and planning what to write before anything is drafted.",
	},
} as const satisfies Record<string, { label: string; description: string }>;

export type PromptFeatureTypeKey = keyof typeof PROMPT_FEATURE_TYPES;

/** Tier 1 as an ordered list, for rendering the catalog's top level. */
export const PROMPT_FEATURE_TYPE_OPTIONS: readonly ({
	key: PromptFeatureTypeKey;
} & (typeof PROMPT_FEATURE_TYPES)[PromptFeatureTypeKey])[] = Object.entries(
	PROMPT_FEATURE_TYPES,
).map(([key, entry]) => ({ key: key as PromptFeatureTypeKey, ...entry }));

/** One thing an agent can be bound for. Mirrors a `PromptBinding` identity. */
export type PromptActionSpec = {
	documentType: string;
	storyKind: PromptStoryKind;
};

export type PromptAgentTarget = {
	/** `PromptBinding.targetKey`. */
	key: string;
	label: string;
	/**
	 * Tier 1 for this agent's actions. A drafting stage overrides to WORK_ITEMS
	 * wherever it is produced — see `promptActionFeatureType`.
	 */
	featureType: PromptFeatureTypeKey;
	/** Every `(documentType, storyKind)` this agent resolves a binding for. */
	actions: readonly PromptActionSpec[];
};

/** Shorthand for the common case: a list of document types with no story kind. */
const nonStage = (...documentTypes: string[]): PromptActionSpec[] =>
	documentTypes.map((documentType) => ({ documentType, storyKind: null }));

/** Shorthand for one document type across several kinds. */
const perKind = (
	documentType: string,
	...kinds: PromptStoryKind[]
): PromptActionSpec[] =>
	kinds.map((storyKind) => ({ documentType, storyKind }));

/**
 * Every agent a prompt can be bound to, and exactly what each can be bound for.
 *
 * Kept in step with `PROMPT_DOCUMENT_TYPE_BINDINGS` in
 * `packages/database/prisma/seed-prompts-only.ts`, which is what actually
 * creates the system bindings. `prompt-action-catalog-covers-seeds.test.ts`
 * fails when a seeded agent has no entry here, because an agent the seeds bind
 * and the catalog omits is a prompt nobody can find or re-bind from the UI.
 */
export const PROMPT_AGENT_TARGETS: readonly PromptAgentTarget[] = [
	{
		key: "project_document_generator",
		label: "Project Document Generator",
		featureType: "PROJECT_DOCUMENTS",
		actions: [
			...nonStage(
				"PRD",
				"PROPOSAL",
				"BUSINESS_CASE",
				"DESIGN_SYSTEM",
				"ARCHITECTURE",
				"TECHNICAL_SPEC",
				"USER_STORY",
				"API_SPEC",
				"QA_STRATEGY",
				"SRS",
				"TEST_PLAN",
				"STORY_BREAKDOWN",
				"TASK_PLAN",
				"CODE_REVIEW",
				"ADR",
				"RUNBOOK",
			),
			// Drafting stages. DRAFT is shared — bug_creation when BUG,
			// feature drafting when FEATURE.
			...perKind("PLACEHOLDER", "FEATURE", "BUG"),
			...perKind("DRAFT", "FEATURE", "BUG"),
			...perKind("ACTIVE_ANALYSIS", "FEATURE"),
			...perKind("SANITY_CHECK", "FEATURE"),
		],
	},
	{
		key: "document_generator",
		label: "Document Generator",
		featureType: "PROJECT_DOCUMENTS",
		actions: nonStage("GENERAL", "PRD", "PROPOSAL", "ARCHITECTURE"),
	},
	{
		// Runs once per new story to decide BUG vs FEATURE.
		key: "work_item_classifier",
		label: "Work Item Classifier",
		featureType: "WORK_ITEMS",
		actions: nonStage("GENERAL"),
	},
	{
		// The roadmap Priority view's "Re-prioritize" button. Editing this
		// prompt changes data: it decides the band each work item is assigned,
		// and the rationale it writes becomes that change's history note.
		key: "priority_reprioritization",
		label: "Priority Reprioritization",
		featureType: "ROADMAP",
		actions: nonStage("GENERAL"),
	},
	{
		// The single-item variant of the above.
		key: "priority_reprioritization_single",
		label: "Priority Reprioritization — single item",
		featureType: "ROADMAP",
		actions: nonStage("GENERAL"),
	},
	{
		key: "story_title_generator",
		label: "Work Item Title Generator",
		featureType: "WORK_ITEMS",
		actions: nonStage("GENERAL"),
	},
	{
		// Re-runs analysis on a work item after it changed.
		key: "feature_reanalyzer",
		label: "Feature Reanalyzer",
		featureType: "WORK_ITEMS",
		actions: perKind("DRAFT", "FEATURE"),
	},
	{
		key: "bug_reanalyzer",
		label: "Bug Reanalyzer",
		featureType: "WORK_ITEMS",
		actions: perKind("DRAFT", "BUG"),
	},
	{
		key: "feature_clean_spec_generator",
		label: "Feature Clean Spec Generator",
		featureType: "WORK_ITEMS",
		// Bound and resolved at CLEAN_SPEC (seed-prompts-only.ts,
		// resolve-story-prompt.ts) — not at the DRAFT drafting stage. This said
		// DRAFT once, and every default set through the UI landed at a slot
		// nothing reads while the seeded prompt kept running.
		actions: perKind("CLEAN_SPEC", "FEATURE"),
	},
	{
		key: "bug_clean_spec_generator",
		label: "Bug Clean Spec Generator",
		featureType: "WORK_ITEMS",
		actions: perKind("CLEAN_SPEC", "BUG"),
	},
	{
		// Decides how many clarifying questions to ask; one prompt per depth.
		key: "clarifying_questions",
		label: "Clarifying Questions",
		featureType: "WORK_ITEMS",
		actions: nonStage("MINIMAL", "BALANCED", "THOROUGH"),
	},
	{
		key: "feature_answer_recommender",
		label: "Feature Answer Recommender",
		featureType: "WORK_ITEMS",
		actions: perKind("ANSWER_RECOMMENDATIONS", "FEATURE"),
	},
	{
		key: "bug_answer_recommender",
		label: "Bug Answer Recommender",
		featureType: "WORK_ITEMS",
		actions: perKind("ANSWER_RECOMMENDATIONS", "BUG"),
	},
	{
		// Folds newly-supplied context back into a work item.
		key: "context_update_instructions",
		label: "Context Update Instructions",
		featureType: "WORK_ITEMS",
		actions: perKind("CONTEXT_UPDATE", "FEATURE", "BUG"),
	},
	{
		// Summarises how far a work item has matured.
		key: "maturation_summary",
		label: "Maturation Summary",
		featureType: "WORK_ITEMS",
		actions: perKind("GENERAL", "FEATURE", "BUG"),
	},
	{
		// The two halves of a duplicate merge: what the merged item says, and
		// what its acceptance criteria become.
		key: "duplicate_merge_description",
		label: "Duplicate Merge — description",
		featureType: "WORK_ITEMS",
		actions: [
			...nonStage("GENERAL"),
			...perKind("GENERAL", "FEATURE", "BUG"),
		],
	},
	{
		key: "duplicate_merge_acceptance",
		label: "Duplicate Merge — acceptance criteria",
		featureType: "WORK_ITEMS",
		actions: [
			...nonStage("GENERAL"),
			...perKind("GENERAL", "FEATURE", "BUG"),
		],
	},
	{
		// The "draft test cases from a feature" prompt used by draftTestCases.
		key: "test_case_drafter",
		label: "Test Case Drafter",
		featureType: "QUALITY",
		actions: nonStage("GENERAL"),
	},
	{
		// Proposes revised steps for ONE case whose feature has changed since
		// the case was drafted.
		key: "test_case_step_reviser",
		label: "Test Case Step Reviser",
		featureType: "QUALITY",
		actions: nonStage("GENERAL"),
	},
	{
		// Proposes revised steps by reading the diff of the pull request that
		// implemented the feature.
		key: "test_case_implementation_reviser",
		label: "Test Case Implementation Reviser",
		featureType: "QUALITY",
		actions: nonStage("GENERAL"),
	},
	{
		// Reviews a pull request Fabric already read for test coverage. Editing
		// it changes what the lens LOOKS FOR; it cannot widen what the lens may
		// cite — `groundFindings` enforces that in code regardless of the prompt.
		key: "pr_review_qa",
		label: "PR review — QA lens",
		featureType: "QUALITY",
		actions: nonStage("GENERAL"),
	},
	{
		// Explains why a test run failed.
		key: "test_failure_analyst",
		label: "Test Failure Analyst",
		featureType: "QUALITY",
		actions: nonStage("GENERAL"),
	},
	{
		// Drives the agentic QA runner.
		key: "qa_agentic_runner",
		label: "QA Agentic Runner",
		featureType: "QUALITY",
		actions: nonStage("GENERAL"),
	},
	{
		key: "qa_analysis_generator",
		label: "QA Analysis Generator",
		featureType: "QUALITY",
		actions: perKind("QA_ANALYSIS", "FEATURE"),
	},
	{
		// The knowledge baseline + false-positive contract injected into the AI
		// security prompt. Falls back to defaultSecurityReviewerGuidance.
		key: "security_scan_reviewer",
		label: "Security scan — reviewer guidance",
		featureType: "SECURITY",
		actions: nonStage("GENERAL"),
	},
	{
		key: "accessibility_scan_reviewer",
		label: "Accessibility scan — reviewer guidance",
		featureType: "SECURITY",
		actions: nonStage("GENERAL"),
	},
	{
		// Adversarial false-positive judge rubric applied during the on-demand
		// finding review.
		key: "security_scan_fp_judge",
		label: "Security scan — false-positive judge",
		featureType: "SECURITY",
		actions: nonStage("GENERAL"),
	},
	{
		// Turns a security finding into a bug.
		key: "security_finding_ticket",
		label: "Security finding — bug ticket",
		featureType: "SECURITY",
		actions: perKind("DRAFT", "BUG"),
	},
	{
		// The pre-meeting agenda prompt. Editing it changes the persona, the
		// section layout and every tuning rule; it cannot remove the grounding
		// and carried-forward classification clauses, appended code-side.
		key: "meeting_agenda_generator",
		label: "Meeting Agenda Generator",
		featureType: "MEETINGS",
		actions: nonStage("GENERAL"),
	},
	{
		// Decides whether an action item captured from a meeting or monitored
		// chat is new work or additional detail on an existing ticket. Editing
		// it changes how readily Fabric enriches rather than creates.
		key: "action_item_routing_judge",
		label: "Action Item Routing Judge",
		featureType: "MEETINGS",
		actions: nonStage("GENERAL"),
	},
	{
		// The pre-draft planning worksheet for a publishing topic. Editing it
		// changes what the analysis considers and how it frames authorship,
		// audience and content-type advice. It cannot remove the output contract
		// or the approval rules (no asset is generated; nothing sensitive is
		// treated as approved) — those are appended code-side.
		key: PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
		label: "Topic Planning & Analysis",
		featureType: "PUBLISHING",
		actions: nonStage("GENERAL"),
	},
	{
		// The short social post drafted from a publishing topic. Editing it
		// changes voice, length and how the three options differ from one
		// another. It cannot remove the output contract (exactly three labeled
		// options) or the approval rules — those are appended code-side, and the
		// option count is enforced by the schema before anything is persisted.
		key: PUBLISHING_SHORT_POST_AGENT_KEY,
		label: "Topic Short Post / Tweet",
		featureType: "PUBLISHING",
		actions: nonStage("GENERAL"),
	},
];

export function findPromptAgentTarget(
	targetKey: string,
): PromptAgentTarget | undefined {
	return PROMPT_AGENT_TARGETS.find((agent) => agent.key === targetKey);
}

/** The drafting stages, which are Work Items wherever they are produced. */
const DRAFTING_STAGES: ReadonlySet<string> = new Set([
	"PLACEHOLDER",
	"ACTIVE_ANALYSIS",
	"SANITY_CHECK",
	"DRAFT",
]);

/**
 * Tier 1 for one action.
 *
 * A drafting stage is Work Items wherever it is produced. The agent that owns
 * the stage is an implementation detail, and filing "draft a feature" under
 * Project Documents — because `project_document_generator` also writes PRDs —
 * would put it exactly where nobody would look for it.
 */
export function promptActionFeatureType(
	agent: PromptAgentTarget,
	documentType: string,
): PromptFeatureTypeKey {
	return DRAFTING_STAGES.has(documentType) ? "WORK_ITEMS" : agent.featureType;
}

/**
 * An agent that never resolves a `storyKind`, so a dialog must not offer one:
 * picking a kind empties its document-type list and strands the user.
 */
export function isNonStageAgent(agent: PromptAgentTarget): boolean {
	return agent.actions.every((a) => a.storyKind === null);
}

/**
 * An agent whose only action is `(GENERAL, null)`, so it resolves exactly one
 * binding no matter what a dialog has in state.
 *
 * Deliberately NOT the same predicate as `isNonStageAgent`, though the two read
 * alike and overlap heavily. `document_generator` never resolves a storyKind
 * yet binds four document types; using the stage predicate to decide whether to
 * override the submitted documentType writes GENERAL while the dropdown still
 * shows PRD.
 */
export function isGeneralOnlyAgent(agent: PromptAgentTarget): boolean {
	return (
		agent.actions.length === 1 &&
		agent.actions[0].documentType === "GENERAL" &&
		agent.actions[0].storyKind === null
	);
}

/** The document types bindable for an agent at a given kind. */
export function bindableDocumentTypes(
	agent: PromptAgentTarget,
	storyKind: PromptStoryKind,
): readonly string[] {
	return [
		...new Set(
			agent.actions
				.filter((a) => a.storyKind === storyKind)
				.map((a) => a.documentType),
		),
	];
}

/** Tier 2 — one entry per thing a prompt can actually be bound to. */
export type PromptAction = {
	/** Stable id for routing and deep links. */
	id: string;
	targetKey: string;
	agentLabel: string;
	documentType: string;
	storyKind: PromptStoryKind;
	featureType: PromptFeatureTypeKey;
	/** What to call this action in a list. */
	label: string;
};

/** `agent:documentType:storyKind` — URL-safe and stable across label renames. */
export function promptActionId(
	targetKey: string,
	documentType: string,
	storyKind: PromptStoryKind,
): string {
	return `${targetKey}:${documentType}:${storyKind ?? "ANY"}`;
}

export function listPromptActions(): PromptAction[] {
	const actions: PromptAction[] = [];

	for (const agent of PROMPT_AGENT_TARGETS) {
		const generalOnly = isGeneralOnlyAgent(agent);

		for (const spec of agent.actions) {
			const kindSuffix =
				spec.storyKind === null
					? ""
					: ` (${spec.storyKind === "FEATURE" ? "Feature" : "Bug"})`;

			actions.push({
				id: promptActionId(
					agent.key,
					spec.documentType,
					spec.storyKind,
				),
				targetKey: agent.key,
				agentLabel: agent.label,
				documentType: spec.documentType,
				storyKind: spec.storyKind,
				featureType: promptActionFeatureType(agent, spec.documentType),
				// An agent that resolves exactly one thing gains nothing from
				// "— General" after its name; an agent whose actions differ
				// only by document type needs it to tell them apart.
				label: generalOnly
					? agent.label
					: `${agent.label} — ${promptDocumentTypeLabel(spec.documentType)}${kindSuffix}`,
			});
		}
	}

	return actions;
}
