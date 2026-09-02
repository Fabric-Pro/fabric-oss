/**
 * Blog Post activities (Publishing Suite Phase 2B-3, Fizzy #1853).
 *
 * Only the two ACTIVITY entry points are re-exported here. The prompt builder is
 * deliberately not: it is the pure half of this slice, imported directly by its
 * tests and by the activity itself, and exporting it from the worker's activity
 * barrel would offer Temporal a function it must never be asked to schedule.
 */

export {
	type GenerateBlogPostInput,
	type GenerateBlogPostOutput,
	generateBlogPostActivity,
} from "./generate-blog-post";
export {
	type MarkBlogPostFailedInput,
	markBlogPostFailedActivity,
} from "./mark-blog-post-failed";
