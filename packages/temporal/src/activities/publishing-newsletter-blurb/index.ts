/**
 * Newsletter Blurb activities (Publishing Suite Phase 2D slice 2D-2,
 * Fizzy #1988).
 *
 * Only the two ACTIVITY entry points are re-exported here. The prompt builder is
 * deliberately not: it is the pure half of this slice, imported directly by its
 * tests and by the activity itself, and exporting it from the worker's activity
 * barrel would offer Temporal a function it must never be asked to schedule.
 */

export {
	type GenerateNewsletterBlurbInput,
	type GenerateNewsletterBlurbOutput,
	generateNewsletterBlurbActivity,
} from "./generate-newsletter-blurb";
export {
	type MarkNewsletterBlurbFailedInput,
	markNewsletterBlurbFailedActivity,
} from "./mark-newsletter-blurb-failed";
