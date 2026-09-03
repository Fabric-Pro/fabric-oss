/**
 * Case Study activities (Publishing Suite Phase 2C, Fizzy #1854).
 *
 * Only the two ACTIVITY entry points are re-exported here. The prompt builder is
 * deliberately not: it is the pure half of this slice, imported directly by its
 * tests and by the activity itself, and exporting it from the worker's activity
 * barrel would offer Temporal a function it must never be asked to schedule.
 */

export {
	type GenerateCaseStudyInput,
	type GenerateCaseStudyOutput,
	generateCaseStudyActivity,
} from "./generate-case-study";
export {
	type MarkCaseStudyFailedInput,
	markCaseStudyFailedActivity,
} from "./mark-case-study-failed";
