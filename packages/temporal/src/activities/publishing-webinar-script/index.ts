/**
 * Webinar / Demo Script activities (Publishing Suite Phase 2D-1, Fizzy #1988).
 *
 * Only the two ACTIVITY entry points are re-exported here. The prompt builder is
 * deliberately not: it is the pure half of this slice, imported directly by its
 * tests and by the activity itself, and exporting it from the worker's activity
 * barrel would offer Temporal a function it must never be asked to schedule.
 */

export {
	type GenerateWebinarScriptInput,
	type GenerateWebinarScriptOutput,
	generateWebinarScriptActivity,
} from "./generate-webinar-script";
export {
	type MarkWebinarScriptFailedInput,
	markWebinarScriptFailedActivity,
} from "./mark-webinar-script-failed";
