/**
 * The codes the Glossy procedures and the build report return, narrowed to the
 * ones `projects.glossy.*` has copy for (Fizzy #2589).
 *
 * Each list is written as a record over the server's own type, so the type
 * checker fails when the server adds a code this page has no copy for. Codes
 * still arrive as plain strings at runtime — a newer server can send one this
 * build has never heard of — so an unknown code maps to generic copy rather
 * than to a raw key path.
 */

import type {
	GlossyBuildErrorCode,
	GlossyBuildStep,
	GlossyKeptOriginalReason,
	GlossyVisualDropReason,
} from "@repo/temporal";
import type { VisualKind } from "@repo/utils/glossy/visual-spec";
import type { GlossyEdition } from "../../hooks/use-glossy-edition";
import type { GlossyVisualFailure } from "../../lib/glossy/visual-render";

type GlossyIneligibleReason = NonNullable<
	GlossyEdition["eligibility"]["reason"]
>;

function codes<T extends string>(record: Record<T, true>): readonly T[] {
	return Object.keys(record) as T[];
}

function pick<T extends string>(
	known: readonly T[],
	value: string | null | undefined,
	fallback: T,
): T {
	return value && (known as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

/** `projects.glossy.visual.kinds.*` */
const VISUAL_KINDS = codes<VisualKind>({
	timeline: true,
	comparison: true,
	stat: true,
	flow: true,
	org_chart: true,
	existing_mermaid: true,
	auto: true,
});

/**
 * Why a visual was left out, a slot was not filled, or regenerate found no
 * valid replacement — plus the browser's own render failures —
 * `projects.glossy.report.dropReasons.*`.
 */
const DROP_REASONS = codes<
	GlossyVisualDropReason | GlossyVisualFailure["reason"] | "unknown"
>({
	truncated: true,
	invalid_spec: true,
	kind_mismatch: true,
	fact_check: true,
	slot_unavailable: true,
	appendix_slot: true,
	invalid_diagram: true,
	visual_unavailable: true,
	render_failed: true,
	unsupported_kind: true,
	unknown: true,
});

/** Why a section kept its cleaned original wording (R16) — `report.keptOriginalReasons.*`. */
const KEPT_ORIGINAL_REASONS = codes<GlossyKeptOriginalReason | "unknown">({
	fact_guard: true,
	truncated: true,
	rewrite_unavailable: true,
	unknown: true,
});

/** `GlossyBuildErrorCode`, `WORKFLOW_START_FAILED` included — `status.errors.*`. */
const BUILD_ERROR_CODES = codes<GlossyBuildErrorCode>({
	AI_PROVIDER_NOT_CONFIGURED: true,
	SOURCE_DOCUMENT_DELETED: true,
	ACCESS_REVOKED: true,
	NOTHING_TO_PRESENT: true,
	NOT_ELIGIBLE: true,
	SUPERSEDED: true,
	BUILD_FAILED: true,
	WORKFLOW_START_FAILED: true,
});

/** `status.steps.*` */
const BUILD_STEPS = codes<GlossyBuildStep | "unknown">({
	preparing: true,
	detecting: true,
	rewriting: true,
	visualizing: true,
	finalizing: true,
	unknown: true,
});

/** Why a document cannot be built now — `ineligible.*`. */
const INELIGIBLE_REASONS = codes<GlossyIneligibleReason>({
	documentType: true,
	generating: true,
	empty: true,
	nothingToPresent: true,
});

/** Every coded subtree of `projects.glossy`, for the locale tests. */
export const GLOSSY_CODED_COPY: Readonly<Record<string, readonly string[]>> = {
	"visual.kinds": VISUAL_KINDS,
	"report.dropReasons": DROP_REASONS,
	"report.keptOriginalReasons": KEPT_ORIGINAL_REASONS,
	"status.errors": BUILD_ERROR_CODES,
	"status.steps": BUILD_STEPS,
	ineligible: INELIGIBLE_REASONS,
};

export function glossyKindKey(kind: string): VisualKind {
	return pick(VISUAL_KINDS, kind, "auto");
}

export function glossyReasonKey(reason: string): (typeof DROP_REASONS)[number] {
	return pick(DROP_REASONS, reason, "unknown");
}

export function glossyKeptOriginalKey(
	reason: string,
): (typeof KEPT_ORIGINAL_REASONS)[number] {
	return pick(KEPT_ORIGINAL_REASONS, reason, "unknown");
}

export function glossyErrorKey(code: string): GlossyBuildErrorCode {
	return pick(BUILD_ERROR_CODES, code, "BUILD_FAILED");
}

export function glossyStepKey(
	step: string | null,
): (typeof BUILD_STEPS)[number] {
	return pick(BUILD_STEPS, step, "unknown");
}

export function glossyIneligibleKey(
	reason: string | null,
): GlossyIneligibleReason {
	return pick(INELIGIBLE_REASONS, reason, "empty");
}
