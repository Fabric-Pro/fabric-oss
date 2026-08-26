/**
 * Stage label for a work item, resolved through the roadmap's own vocabulary.
 *
 * `DRAFTING_STAGE_META` is where the product defines what each drafting stage is
 * CALLED (the roadmap, the story cards and the stage pickers all read it), so a
 * coverage row reuses it rather than inventing a second set of stage names that
 * would drift from the roadmap the reader just came from.
 *
 * Two things make a direct lookup unsafe, and this helper absorbs both:
 *  - the API returns the DATABASE enum, which still carries the soft-deprecated
 *    `PASSIVE_ANALYSIS` that the front-end union deliberately dropped, and
 *  - a stage added to the schema later would land here before this map knows it.
 * Either way an unknown stage yields null and the caller renders no chip —
 * never a crashed row over a label.
 */

import { DRAFTING_STAGE_META } from "../../lib/stories/types";

/** Widened to a string key so an unknown/DB-only stage misses instead of throwing. */
const STAGE_LABELS: Record<string, { label: string } | undefined> =
	DRAFTING_STAGE_META;

export function featureStageLabel(stage: string): string | null {
	return STAGE_LABELS[stage]?.label ?? null;
}
