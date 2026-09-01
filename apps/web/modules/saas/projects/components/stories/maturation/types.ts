/**
 * Local view-model types for the Feature Maturation V2 three-tab editor (TG5).
 *
 * These mirror the `maturation.getEditorState` Zod output DTO
 * (`packages/api/.../maturation/schemas.ts`) but are declared here so the panel
 * components don't deep-import API-package internals. The shapes are kept in
 * lock-step with `DecisionLogThreadSchema` / `EffectiveApprovalModesSchema`;
 * the procedure's Zod `.output()` is the runtime source of truth.
 */

export type DecisionStatus =
	| "OPEN"
	| "RESOLVED"
	| "REJECTED"
	| "FORMATTING_ONLY"
	| "POSSIBLY_RESOLVED";

type DecisionAuthorType = "USER" | "AGENT";

type DecisionSource = "HUMAN" | "AI_CONFIRMED";

type DecisionLogReply = {
	id: string;
	status: DecisionStatus;
	summary: string | null;
	content: string | null;
	authorType: DecisionAuthorType;
	source: DecisionSource;
	authorName: string | null;
	sourceProvenance: string | null;
	createdAt: Date;
	/**
	 * Set on an answer turn that REPLACES an earlier one (#1910). The turn it
	 * points at stays in the thread as history; the panel renders it collapsed
	 * under the live answer. Null on roots and on un-amended answers.
	 */
	supersedesId: string | null;
};

type CleanSpecPropagationStatus =
	| "applied"
	| "pending"
	| "refused"
	| "noop"
	| "skipped"
	| "error";

type CleanSpecPropagationSummary = {
	status: CleanSpecPropagationStatus;
	appliedSummaries: string[];
	pendingPatchCount: number;
} | null;

export type AnswerSource = "AI_SUGGESTED" | "AI_EDITED" | "MANUAL";

type DecisionLogRoot = DecisionLogReply & {
	impactedSection: string | null;
	topic: string | null;
	questionId: string | null;
	decidedBy: string | null;
	cleanSpecPropagation: CleanSpecPropagationSummary;
	// AI answer recommendations for an OPEN question (#7). 0–4 candidate answers,
	// each with a justification (FR-2). Empty = no recommendation (plain question).
	suggestedOptions: SuggestedAnswerOption[];
};

export type SuggestedAnswerOption = {
	text: string;
	justification: string;
};

export type DecisionLogThread = {
	root: DecisionLogRoot;
	replies: DecisionLogReply[];
};

/**
 * QA tab — mirrors `QaAnalysisContentSchema`. Test cases are NOT
 * part of this shape; they are real TestCase rows fetched via `testCases.list`.
 */
export type QaAnalysisView = {
	warnings: {
		criterionRef: string;
		warning: string;
		/**
		 * Set when writing the test cases is what exposed this gap, rather than
		 * the criterion being vague on its own terms. Optional: absent on every
		 * analysis stored before it was parsed out, and on standard-flow
		 * projects where the cases are drafted from this review rather than read
		 * by it.
		 */
		fromDraftedCases?: boolean;
	}[];
	integrationNotes: string;
	e2eScenarios: string;
	depth: "LIGHT" | "STANDARD" | "STRICT";
	specHash: string;
	generatedAt: string;
	/** How many test cases this review read. Test-first projects only. */
	reviewedAgainstCaseCount?: number;
};

/**
 * Somebody a question is waiting on (Fizzy #1751).
 *
 * `assignedByUserId` is who asked — the person told when the question is
 * answered. After a re-assignment that is not necessarily whoever asked first,
 * which is the point: hand a question on and you are the one who hears back.
 */
export type QuestionAssignee = {
	id: string;
	name: string | null;
	avatarUrl: string | null;
	assignedByUserId: string;
};
