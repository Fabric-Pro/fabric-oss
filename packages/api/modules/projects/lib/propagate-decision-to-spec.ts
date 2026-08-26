/**
 * TG4 — Decision → Clean-Spec propagation.
 *
 * When a PO confirms a decision (answers an open question / records a gap
 * resolution), that decision is propagated into the Clean Spec as a set of
 * SCOPED `{ from, to }` patches — never a full rewrite. Phase 0 proved the model
 * emits tight, verbatim-locatable patches across deletion / replacement / prose
 * / multi-criteria edits, so the Clean Spec stays one freetext markdown field
 * with no stored anchors.
 *
 * This module is the orchestrator: combine the Clean Spec → ask the model for
 * patches → apply them deterministically (`applySpecPatches`) → branch on the
 * effective Clean-Spec approval mode:
 *
 *   - AUTO_ACCEPT → write description/AC through the versioned write below
 *     (snapshots a FeatureVersion and fires PM sync only when the feature's
 *     `pmAutoSyncEnabled` cloud toggle is on — same gate as a v1 editor save).
 *   - MANUAL      → persist the proposed patch set as PENDING on the decision;
 *     the Clean Spec is NOT written here (the accept flow lands in TG6).
 *
 * Safety: if ANY patch fails to locate verbatim, the WHOLE set is refused — the
 * Clean Spec is left byte-identical and the failure is surfaced on the decision.
 * A mis-located patch must never silently corrupt the spec the PO trusts.
 *
 * The caller (the answerQuestion seam) treats propagation as best-effort: it
 * runs AFTER the decision is durably recorded and must never make answering
 * throw — a propagation error leaves the decision standing and the spec
 * untouched.
 */

import { getLockedAttachmentRulesClause } from "@repo/agent-prompts";
import { generateObject, getAIModelWithMetadata } from "@repo/ai";
// Imported from the SUBPATH so callers clamp output-token budgets identically to
// the merged reference site (update-with-context-core.ts). See the helper for
// the Databricks 8,192 / Anthropic-direct 4,096 truncation this guards against.
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	effectiveApprovalMode,
	type FeatureMaturationState,
	getApprovalPreference,
	type MaturationApprovalMode,
	type MaturationTenantFilter,
} from "@repo/database";
import {
	combineCleanSpec,
	splitCleanSpec,
} from "@repo/utils/clean-spec-content";
import { zodSchema } from "ai";
import { writeCleanSpecWithVersion } from "./clean-spec-write";
import {
	applySpecPatches,
	buildSpecPatchPrompt,
	type PatchFailure,
	type SpecPatch,
	SpecPatchSetSchema,
} from "./spec-patch";

type PropagationStatus =
	/** AUTO_ACCEPT: patches applied and the Clean Spec written + versioned. */
	| "applied"
	/** MANUAL: patches located but held as PENDING for review (no write). */
	| "pending"
	/** A patch could not be located verbatim — whole set refused, spec untouched. */
	| "refused"
	/** The decision did not change the spec (model returned no patches). */
	| "noop"
	/** The feature is not opted into v2 — propagation intentionally skipped. */
	| "skipped";

export interface PropagationOutcome {
	status: PropagationStatus;
	/** Effective Clean-Spec approval mode (null when skipped before resolution). */
	mode: MaturationApprovalMode | null;
	/** Patches written to the spec (AUTO_ACCEPT) — empty otherwise. */
	applied: SpecPatch[];
	/** Patches awaiting manual accept (MANUAL) — empty otherwise. */
	pending: SpecPatch[];
	/** Patches that could not be located verbatim (refusal cause). */
	failed: PatchFailure[];
	/** Whether a PM-sync push was enqueued (AUTO_ACCEPT + cloud toggle on). */
	pmSyncEnqueued: boolean;
}

export interface PropagateDecisionParams {
	feature: FeatureMaturationState;
	projectId: string;
	tenantFilter: MaturationTenantFilter;
	/** The confirmed decision in natural language (the PO's answer + summary). */
	decisionText: string;
}

const EMPTY = Object.freeze<
	Pick<PropagationOutcome, "applied" | "pending" | "failed">
>({ applied: [], pending: [], failed: [] });

/**
 * Ask the model for the scoped patch set that reflects `decisionText` in the
 * combined Clean-Spec markdown. Model resolution is tenant-coupled and routes
 * through the configured provider (usage limits are enforced at resolution).
 */
async function generateCleanSpecPatches(params: {
	spec: string;
	decisionText: string;
	tenantFilter: MaturationTenantFilter;
}): Promise<SpecPatch[]> {
	const { model, metadata } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: params.tenantFilter.userId,
			organizationId: params.tenantFilter.organizationId ?? undefined,
			featureKey: "maturation",
		},
	);

	// FR-25: append the shared locked-attachment
	// rule so decision→spec propagation never drops/mutates a locked
	// attachment reference or fabricates one while patching the spec.
	// No-op today (no attachment metadata reaches AI context).
	const prompt = `${buildSpecPatchPrompt(params.decisionText, params.spec)}\n\n${getLockedAttachmentRulesClause()}`;

	// Scaled mode: the model emits verbatim `from`/`to` patch blocks, so output
	// tracks the spec size. Without an explicit budget Databricks/Anthropic-direct
	// truncate the patch set at their injected defaults; `undefined` for providers
	// that don't need the workaround (they keep their SDK defaults).
	const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
		inputChars: params.spec.length,
		promptChars: prompt.length,
	});

	const { object } = await generateObject({
		model,
		schema: zodSchema(SpecPatchSetSchema),
		prompt,
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	});

	return object.patches;
}

/** One-line change summary for the version trail, from the applied patches. */
function summarize(patches: SpecPatch[]): string {
	const text = patches.map((p) => p.summary).join("; ");
	return text.length > 280
		? `${text.slice(0, 277)}...`
		: text || "spec update";
}

/**
 * Propagate a confirmed decision into the Clean Spec. May throw on model/DB
 * failure — the caller wraps this so answering never fails because of
 * propagation.
 */
export async function propagateDecisionToCleanSpec(
	params: PropagateDecisionParams,
): Promise<PropagationOutcome> {
	const { feature, projectId, tenantFilter, decisionText } = params;

	// Gate: only features opted into v2 auto-propagate. A non-opted feature still
	// records the decision (upstream), but its Clean Spec is never auto-mutated.
	if (!feature.maturationV2OptedIn) {
		return {
			status: "skipped",
			mode: null,
			...EMPTY,
			pmSyncEnqueued: false,
		};
	}

	// Effective Clean-Spec mode: per-feature override → per-user default → hard
	// default (AUTO_ACCEPT). The single source of truth is `effectiveApprovalMode`.
	const pref = await getApprovalPreference({ tenantFilter });
	const mode = effectiveApprovalMode(
		feature,
		pref
			? {
					cleanSpecMode: pref.cleanSpecMode,
					decisionLogMode: pref.decisionLogMode,
					summaryQuestionsMode: pref.summaryQuestionsMode,
				}
			: null,
		"cleanSpec",
	);

	const spec = combineCleanSpec(
		feature.description,
		feature.acceptanceCriteria,
	);
	if (!spec.trim()) {
		// Empty Clean Spec — nothing to patch (a decision on a brand-new feature).
		return { status: "noop", mode, ...EMPTY, pmSyncEnqueued: false };
	}

	const patches = await generateCleanSpecPatches({
		spec,
		decisionText,
		tenantFilter,
	});
	if (patches.length === 0) {
		return { status: "noop", mode, ...EMPTY, pmSyncEnqueued: false };
	}

	const { result, applied, failed } = applySpecPatches(spec, patches);

	// Any unlocated patch refuses the WHOLE set — partial application of a single
	// coherent decision would leave the spec in an undefined middle state.
	if (failed.length > 0) {
		return {
			status: "refused",
			mode,
			applied: [],
			pending: [],
			failed,
			pmSyncEnqueued: false,
		};
	}

	if (mode === "MANUAL") {
		// Hold for review: persist the proposed patches as PENDING (caller stamps
		// them onto the decision metadata); do NOT write the Clean Spec.
		return {
			status: "pending",
			mode,
			applied: [],
			pending: applied,
			failed: [],
			pmSyncEnqueued: false,
		};
	}

	// AUTO_ACCEPT: write the patched spec back, versioned + PM-sync gated.
	const split = splitCleanSpec(result);
	const { pmSyncEnqueued } = await writeCleanSpecWithVersion({
		projectId,
		storyId: feature.id,
		tenantFilter,
		newDescription: split.description,
		newAcceptanceCriteria: split.acceptanceCriteria,
		changeSummary: summarize(applied),
	});

	return {
		status: "applied",
		mode,
		applied,
		pending: [],
		failed: [],
		pmSyncEnqueued,
	};
}
