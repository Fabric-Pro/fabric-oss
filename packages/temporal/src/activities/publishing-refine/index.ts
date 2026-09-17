/**
 * Working-draft refinement activities (Fizzy #1851 follow-up).
 *
 * Only the two ACTIVITY entry points are re-exported. The prompt builder is
 * deliberately not: it is the pure half of this slice, imported directly by its
 * tests and by the activity itself, and exporting it from the worker's activity
 * barrel would offer Temporal a function it must never be asked to schedule.
 */

export {
	type MarkRefinementFailedInput,
	markRefinementFailedActivity,
} from "./mark-refinement-failed";
export {
	type RefineWorkingDraftInput,
	type RefineWorkingDraftOutput,
	refineWorkingDraftActivity,
} from "./refine-working-draft";
