/**
 * Contract of the Glossy edition build (Fizzy #2589, KTD3, KTD24): the
 * workflow input the build procedure starts it with, and what each activity
 * takes and returns.
 *
 * Types only, so the workflow bundle and the API can import them without
 * pulling in an activity's dependencies.
 *
 * Every result carries keys, kinds, and reason codes — never section text,
 * model output, or a spec. Bodies stay in the database: each activity reads
 * its attempt's snapshot, and model outputs travel through the segment cache,
 * which finalize reads back.
 */

import type { GlossyDetectableKind } from "@repo/agent-prompts/glossy";
import type { GlossyEligibleDocumentType } from "@repo/utils/glossy/eligibility";
import type { GlossyBuildNonRetryableErrorType } from "../../workflows/ai-non-retryable-errors";

export type GlossyBuildMode = "roll_the_dice" | "align_first";

export type GlossyBuildLengthMode = "brief" | "standard";

/** A visual an editor confirmed in Align first, or one a rebuild pins. */
export interface GlossyOpportunityRef {
	sectionKey: string;
	kind: GlossyDetectableKind;
}

/**
 * Build options as the editor confirmed them; the claim stores the same
 * object on the attempt and on the edition's `lastOptions`.
 */
export interface GlossyBuildOptions {
	mode: GlossyBuildMode;
	lengthMode: GlossyBuildLengthMode;
	/** Shapes extraction only (KTD8); bounded before it reaches a model. */
	styleDirection?: string | null;
	/**
	 * Align first: the opportunities the editor kept. The build extracts
	 * exactly these and runs no detection of its own (KTD10). Ignored by
	 * Roll the dice.
	 */
	confirmedOpportunities?: GlossyOpportunityRef[];
}

/** The ids every activity is keyed on. The claim wrote them; none is trusted without a re-check. */
export interface GlossyBuildRef {
	buildId: string;
	documentId: string;
	projectId: string;
	/** The document's organization, as the build procedure's gate resolved it. */
	organizationId: string;
	/** The editor who started the build: access re-checks and model resolution run as them. */
	startedById: string;
}

/**
 * `glossyEditionBuildWorkflow`'s only argument: ids and options, never the
 * document. The starter sets a 30-minute execution timeout and the workflow
 * id `glossyEditionBuildWorkflowId(documentId, buildId)`.
 */
export interface GlossyEditionBuildWorkflowInput extends GlossyBuildRef {
	options: GlossyBuildOptions;
}

export type GlossyEditionBuildWorkflowOutput =
	| { status: "succeeded"; editionId: string; contentRevision: number }
	/** Another attempt holds the claim; nothing of this run was published. */
	| { status: "superseded" };

/**
 * A failure code persisted on the attempt: a verdict, the catch-all, or
 * `WORKFLOW_START_FAILED`, which the build procedure's `releaseGlossyClaim`
 * writes when Temporal refused the start — the run never existed, so no
 * activity ever records that one.
 */
export type GlossyBuildErrorCode =
	| GlossyBuildNonRetryableErrorType
	| "BUILD_FAILED"
	| "WORKFLOW_START_FAILED";

/** What the attempt row shows while the build runs. */
export type GlossyBuildStep =
	| "preparing"
	| "detecting"
	| "rewriting"
	| "visualizing"
	| "finalizing";

/** Sections rewritten so far, as the workflow counted them when it scheduled the activity. */
export interface GlossyBuildProgressInput {
	sectionsDone: number;
	sectionsTotal: number;
}

/** A visual kind an extraction may be asked for; `auto` lets a best-fit slot choose. */
export type GlossyBuildExtractKind = GlossyDetectableKind | "auto";

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

export interface PrepareGlossyBuildInput extends GlossyBuildRef {
	options: GlossyBuildOptions;
}

export interface GlossyBuildSlotRef {
	slotId: string;
	sectionKey: string;
	kind: GlossyBuildExtractKind;
}

export interface PrepareGlossyBuildResult {
	documentType: GlossyEligibleDocumentType;
	/** Main-flow section keys, in document order. */
	sectionKeys: string[];
	/** Visual slots to fill, in document order (R22). */
	slots: GlossyBuildSlotRef[];
	/**
	 * Opportunities to extract without detecting: Align first's confirmed
	 * list, or on a rebuild the prior opportunities of unchanged sections
	 * (KTD9). Never one a slot of the same section and kind overrides.
	 */
	opportunities: GlossyOpportunityRef[];
	/**
	 * Detection still to run: over every section on a first build, over the
	 * changed sections on a rebuild, with what is left of the budget. `null`
	 * for Align first, or when nothing changed or no budget is left.
	 */
	detection: { sectionKeys: string[]; limit: number } | null;
}

// ---------------------------------------------------------------------------
// Detect
// ---------------------------------------------------------------------------

export interface DetectGlossyOpportunitiesActivityInput extends GlossyBuildRef {
	documentType: GlossyEligibleDocumentType;
	/** Sections to consider, in document order. */
	sectionKeys: string[];
	limit: number;
	progress: GlossyBuildProgressInput;
}

export interface DetectGlossyOpportunitiesActivityResult {
	/** In document order; each reason stays in the detection cache row. */
	opportunities: GlossyOpportunityRef[];
	/** The detection cache row holding them, or `null` when detection degraded. */
	cacheKey: string | null;
	fromCache: boolean;
}

// ---------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------

export interface RewriteGlossySectionActivityInput extends GlossyBuildRef {
	documentType: GlossyEligibleDocumentType;
	lengthMode: GlossyBuildLengthMode;
	sectionKey: string;
	progress: GlossyBuildProgressInput;
}

/** Why a section kept its cleaned original wording (R16), as persisted in the report. */
export type GlossyKeptOriginalReason =
	| "fact_guard"
	| "truncated"
	| "rewrite_unavailable";

export type RewriteGlossySectionActivityResult =
	| {
			sectionKey: string;
			outcome: "rewritten";
			/** The rewrite cache row holding the text. */
			cacheKey: string;
			fromCache: boolean;
	  }
	| {
			sectionKey: string;
			outcome: "keptOriginal";
			reason: Exclude<GlossyKeptOriginalReason, "rewrite_unavailable">;
	  }
	/** A heading-only section: nothing to rewrite, no model call. */
	| { sectionKey: string; outcome: "empty" };

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

export interface ExtractGlossyVisualActivityInput extends GlossyBuildRef {
	documentType: GlossyEligibleDocumentType;
	sectionKey: string;
	kind: GlossyBuildExtractKind;
	/** Set for a slot; `null` for a detected, pinned, or confirmed opportunity. */
	slotId: string | null;
	styleDirection: string | null;
	progress: GlossyBuildProgressInput;
}

/** Why a visual was left out (R18, R22), as persisted in the report. */
export type GlossyVisualDropReason =
	| "truncated"
	| "invalid_spec"
	| "kind_mismatch"
	| "fact_check"
	/** A slot the source no longer holds, or holds twice. */
	| "slot_unavailable"
	/** A slot in the source's own Appendix, which the build never illustrates. */
	| "appendix_slot"
	/** An existing diagram whose source cannot form a valid spec. */
	| "invalid_diagram"
	/** The extraction's cache row was gone by the time finalize read it. */
	| "visual_unavailable";

export type ExtractGlossyVisualActivityResult =
	| {
			sectionKey: string;
			slotId: string | null;
			visualKey: string;
			outcome: "extracted";
			/** The resolved kind; a best-fit slot's is only known now. */
			kind: GlossyDetectableKind;
			/** The extraction cache row holding the spec. */
			cacheKey: string;
			fromCache: boolean;
	  }
	| {
			sectionKey: string;
			slotId: string | null;
			visualKey: string;
			outcome: "dropped";
			/** The kind that was asked for. */
			kind: GlossyBuildExtractKind;
			reason: GlossyVisualDropReason;
	  };

// ---------------------------------------------------------------------------
// Finalize and fail
// ---------------------------------------------------------------------------

export interface FinalizeGlossyBuildActivityInput extends GlossyBuildRef {
	documentType: GlossyEligibleDocumentType;
	options: GlossyBuildOptions;
	rewrites: RewriteGlossySectionActivityResult[];
	visuals: ExtractGlossyVisualActivityResult[];
	/** This build's detection cache row, for the detected reasons. */
	detectionCacheKey: string | null;
}

export type FinalizeGlossyBuildActivityResult =
	| { outcome: "applied"; editionId: string; contentRevision: number }
	| { outcome: "superseded" };

export interface FailGlossyBuildActivityInput extends GlossyBuildRef {
	/** The failure's type as the workflow read it; anything unknown persists as `BUILD_FAILED`. */
	code: string;
	/** The failure's own message, for the log only, after redaction. Never persisted. */
	detail?: string | null;
}

export interface FailGlossyBuildActivityResult {
	outcome: "applied" | "superseded";
	code: GlossyBuildErrorCode;
}
