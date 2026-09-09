/**
 * LinkedIn Post activities (Fizzy #1851).
 *
 * Only the two ACTIVITY entry points are re-exported here. The prompt builder is
 * deliberately not: it is the pure half of this slice, imported directly by its
 * tests and by the activity itself, and exporting it from the worker's activity
 * barrel would offer Temporal a function it must never be asked to schedule.
 */

export {
	type GenerateLinkedInPostInput,
	type GenerateLinkedInPostOutput,
	generateLinkedInPostActivity,
} from "./generate-linkedin-post";
export {
	type MarkLinkedInPostFailedInput,
	markLinkedInPostFailedActivity,
} from "./mark-linkedin-post-failed";
