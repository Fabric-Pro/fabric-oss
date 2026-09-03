/**
 * Stakeholder Email activities (Publishing Suite Phase 2C, Fizzy #1854).
 *
 * Only the two ACTIVITY entry points are re-exported here. The prompt builder is
 * deliberately not: it is the pure half of this slice, imported directly by its
 * tests and by the activity itself, and exporting it from the worker's activity
 * barrel would offer Temporal a function it must never be asked to schedule.
 */

export {
	type GenerateStakeholderEmailInput,
	type GenerateStakeholderEmailOutput,
	generateStakeholderEmailActivity,
} from "./generate-stakeholder-email";
export {
	type MarkStakeholderEmailFailedInput,
	markStakeholderEmailFailedActivity,
} from "./mark-stakeholder-email-failed";
