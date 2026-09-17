/**
 * How long a saved working draft may be, per content type (Fizzy #1851
 * follow-up).
 *
 * ONE definition, because these numbers are a CONTRACT between two sides that
 * were previously written apart. The editor's save procedure bounds what a
 * person may type; the refinement's output schema bounds what a model may
 * propose. When those disagree, a refinement can commit a body the editor then
 * refuses to save — the panel shows a perfectly good revision, the author fixes
 * a typo in it, and their save is rejected on a limit nothing on screen
 * mentions. A refined tweet of 5,000 characters was exactly that bug.
 *
 * The values are the ones the save procedures already enforced, gathered rather
 * than re-decided:
 *
 *   - TWEET 2,000 — generous against X's own limit on purpose. This is the
 *     draft a person is working ON, and clamping it to the publish limit would
 *     refuse an edit that is one word over on its way to being two words under.
 *   - LINKEDIN_POST 6,000 — LinkedIn folds behind "see more" rather than
 *     capping hard, so its drafts legitimately run longer than a tweet's.
 *   - STAKEHOLDER_EMAIL 24,000, and NEWSLETTER_BLURB the same figure imported
 *     from `publishing-newsletter-blurb-body.ts`, which already owned it.
 *   - BLOG_POST, CASE_STUDY and WEBINAR_SCRIPT 40,000 — the long-form ceiling.
 *
 * Keyed by the full `PublishingTopicPostType` enum, so adding a content type
 * without a limit is a TypeScript error rather than a silent fall-through to
 * whatever the last writer assumed.
 */

import { NEWSLETTER_BLURB_BODY_MAX } from "./publishing-newsletter-blurb-body";

export type PublishingWorkingDraftPostType =
	| "TWEET"
	| "LINKEDIN_POST"
	| "BLOG_POST"
	| "CASE_STUDY"
	| "STAKEHOLDER_EMAIL"
	| "WEBINAR_SCRIPT"
	| "NEWSLETTER_BLURB";

export const WORKING_DRAFT_BODY_MAX: Readonly<
	Record<PublishingWorkingDraftPostType, number>
> = {
	TWEET: 2000,
	LINKEDIN_POST: 6000,
	BLOG_POST: 40_000,
	CASE_STUDY: 40_000,
	STAKEHOLDER_EMAIL: 24_000,
	WEBINAR_SCRIPT: 40_000,
	// Imported, not repeated: that module owns this number and its reasoning.
	NEWSLETTER_BLURB: NEWSLETTER_BLURB_BODY_MAX,
};

/**
 * The largest body any content type can hold.
 *
 * Derived rather than written down, so it cannot fall behind the map. Used where
 * a bound must cover every type at once — `CURRENT_DRAFT_CHAR_CAP`'s reasoning,
 * and any guard that runs before the post type is known.
 */
export const WORKING_DRAFT_BODY_MAX_ANY = Math.max(
	...Object.values(WORKING_DRAFT_BODY_MAX),
);
