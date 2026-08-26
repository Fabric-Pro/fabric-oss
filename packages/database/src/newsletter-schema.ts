import { z } from "zod";

export const NEWSLETTER_SCHEMA_VERSION = 1;

/** One curated "major feature" line item in a newsletter. */
export const newsletterHighlightSchema = z.object({
	title: z.string().min(1).max(160),
	description: z.string().min(1),
	// GithubItem.url is a plain string (not validated as URL upstream), so keep this lenient.
	prUrl: z.string().optional(),
	// Normalized release metadata, attached at curation time, so the email can group
	// highlights by release. Optional ⇒ rollback-safe (schemaVersion stays 1); legacy
	// content lacks these and the email helper falls back to parsing prUrl.
	releaseTag: z.string().optional(),
	repoFullName: z.string().optional(),
});
export type NewsletterHighlight = z.infer<typeof newsletterHighlightSchema>;

/**
 * Persisted curated newsletter content. Additive/rollback-safe: only optional
 * keys may be added later; never grow a strict enum (mirrors daily-brief-schema).
 */
export const newsletterContentSchema = z.object({
	schemaVersion: z.literal(1),
	headline: z.string(),
	intro: z.string(),
	highlights: z.array(newsletterHighlightSchema),
	// false => the workflow marks the send SKIPPED_EMPTY and mails nobody.
	hasMajorFeatures: z.boolean(),
});
export type NewsletterContent = z.infer<typeof newsletterContentSchema>;

/**
 * Why a newsletter send produced no email. Persisted on NewsletterSend.skipReason
 * (only when status === "SKIPPED_EMPTY"). The workflow sets it; the web UI maps it
 * to a human-readable label. Plain string union (matches the String column).
 */
export const NEWSLETTER_SKIP_REASONS = [
	"NO_ACTIVE_REPOS",
	"NO_RELEASES",
	"NO_MAJOR_FEATURES",
	"INCOMPLETE_SCAN",
	"NO_SUBSCRIBERS",
	"NO_CHAT_TARGETS",
] as const;
export type NewsletterSkipReason = (typeof NEWSLETTER_SKIP_REASONS)[number];

/**
 * Configurable verbosity tier for the AI-generated newsletter. Discrete named
 * tiers (not a slider) for testable, consistent prompt engineering. STANDARD is
 * the default and reproduces the historical prompt exactly. Plain string union
 * (matches the `NewsletterSettings.detailLevel` / `NewsletterSend.detailLevel`
 * String columns).
 */
export const NEWSLETTER_DETAIL_LEVELS = [
	"BRIEF",
	"STANDARD",
	"DETAILED",
] as const;
export type NewsletterDetailLevel = (typeof NEWSLETTER_DETAIL_LEVELS)[number];
export const DEFAULT_NEWSLETTER_DETAIL_LEVEL: NewsletterDetailLevel =
	"STANDARD";

/** Coerce any stored/incoming value to a valid tier; unknown → default. This is
 *  the defense-in-depth layer for values already persisted in the DB (schema
 *  drift / rows written before validation existed). */
export function coerceDetailLevel(value: unknown): NewsletterDetailLevel {
	return (NEWSLETTER_DETAIL_LEVELS as readonly string[]).includes(
		value as string,
	)
		? (value as NewsletterDetailLevel)
		: DEFAULT_NEWSLETTER_DETAIL_LEVEL;
}

/**
 * Where a project's release-notes are delivered. EMAIL is the historical
 * default (zero behavior change on migration). Plain string union — matches the
 * `NewsletterSettings.deliveryDestination` / `NewsletterSend.deliveryDestination`
 * String columns.
 */
export const NEWSLETTER_DELIVERY_DESTINATIONS = [
	"EMAIL",
	"CHAT",
	"BOTH",
] as const;
export type NewsletterDeliveryDestination =
	(typeof NEWSLETTER_DELIVERY_DESTINATIONS)[number];
export const DEFAULT_NEWSLETTER_DELIVERY_DESTINATION: NewsletterDeliveryDestination =
	"EMAIL";

/** Coerce any stored/incoming value to a valid destination; unknown → EMAIL. */
export function coerceDeliveryDestination(
	value: unknown,
): NewsletterDeliveryDestination {
	return (NEWSLETTER_DELIVERY_DESTINATIONS as readonly string[]).includes(
		value as string,
	)
		? (value as NewsletterDeliveryDestination)
		: DEFAULT_NEWSLETTER_DELIVERY_DESTINATION;
}

/** Chat platforms Fabric can deliver release-notes to (reusing existing OAuth
 *  connected-channel integrations). */
export const NEWSLETTER_CHAT_PLATFORMS = ["TEAMS", "SLACK"] as const;
export type NewsletterChatPlatform = (typeof NEWSLETTER_CHAT_PLATFORMS)[number];

/**
 * A selected chat delivery target, persisted as JSON on
 * `NewsletterSettings.chatChannels`. `teamId` is the Teams `teamId` OR the Slack
 * `slackTeamId` (workspace/team id); `channelName` is a denormalized label for
 * display only — the (platform, teamId, channelId) triple is authoritative and
 * is re-validated against the live linked-channel set at send time.
 */
export const newsletterChatChannelSchema = z.object({
	platform: z.enum(NEWSLETTER_CHAT_PLATFORMS),
	teamId: z.string().min(1),
	channelId: z.string().min(1),
	channelName: z.string().optional(),
});
export type NewsletterChatChannel = z.infer<typeof newsletterChatChannelSchema>;

/**
 * A selected target for the release-notes REVIEW ALERT, persisted as JSON on
 * `NewsletterSettings.approvalChatChannels` (Fizzy #2203).
 *
 * Structurally identical to `newsletterChatChannelSchema` and deliberately NOT
 * an alias of it: each persisted-JSON settings column owns its own schema so
 * one column's shape can evolve without silently rewriting the other's stored
 * rows. Same convention as `publishing-chat-channel.ts`.
 *
 * This is a SEPARATE list from `chatChannels`, which is the audience for the
 * published notes. The audience list is empty for every email-delivery project,
 * and a reviewer ping does not belong in a customer-facing announcement channel.
 */
export const newsletterApprovalChatChannelSchema = z.object({
	platform: z.enum(NEWSLETTER_CHAT_PLATFORMS),
	teamId: z.string().min(1),
	channelId: z.string().min(1),
	channelName: z.string().optional(),
});
export type NewsletterApprovalChatChannel = z.infer<
	typeof newsletterApprovalChatChannelSchema
>;

/**
 * What a `NewsletterChatDelivery` row records. CONTENT is the published
 * release-notes post; APPROVAL is the "awaiting review" alert. The value is
 * part of the row's unique key, so both can exist for one send+channel — the
 * normal path when an alerted channel also receives the approved notes.
 */
export const NEWSLETTER_CHAT_DELIVERY_KINDS = ["CONTENT", "APPROVAL"] as const;
export type NewsletterChatDeliveryKind =
	(typeof NEWSLETTER_CHAT_DELIVERY_KINDS)[number];

/**
 * All NewsletterSend.status values. Plain string union (matches the String
 * column). PENDING_APPROVAL/APPROVED/REJECTED/EXPIRED were added by the approval
 * gate (Fizzy 1869). APPROVED is the non-rejectable in-flight state that closes
 * the approve/reject race; EXPIRED is a stale held draft auto-recovered by the
 * scheduled path.
 */
export const NEWSLETTER_SEND_STATUSES = [
	"PENDING",
	"PENDING_APPROVAL",
	"APPROVED",
	"SENT",
	"PARTIAL",
	"FAILED",
	"SKIPPED_EMPTY",
	"REJECTED",
	"EXPIRED",
] as const;
export type NewsletterSendStatus = (typeof NEWSLETTER_SEND_STATUSES)[number];

/** A held PENDING_APPROVAL draft older than this is superseded to EXPIRED by the
 *  scheduled dispatch path so an abandoned review never wedges the cadence
 *  (Fizzy 1869 / Codex finding 2). 14 days ≈ 2 weekly cycles. */
export const STALE_APPROVAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** An APPROVED row whose send workflow was hard-killed / timed out (the send
 *  workflow has a 15m execution timeout) before its outer catch could finalize it
 *  would otherwise wedge the active-send slot. The scheduled reclaim terminalizes
 *  any APPROVED row whose `reviewedAt` (≈ approval time) is older than this to
 *  FAILED. 1 hour ≫ the 15m send timeout, so no genuinely-running send is ever
 *  cut short (Codex final-review backstop). Measured from `reviewedAt`, NOT
 *  `createdAt` — a draft may be held for days before approval. */
export const STALE_APPROVED_MS = 60 * 60 * 1000;

/** Reviewer's removed-highlight index set. Non-negative integers; deduped and
 *  bounded to a sane length so a crafted input can't blow up the filter. */
export const removedHighlightIndexesSchema = z
	.array(z.number().int().min(0))
	.max(500);

/** Coerce any stored/incoming value to a clean index array; junk → []. */
export function coerceRemovedHighlightIndexes(value: unknown): number[] {
	const parsed = removedHighlightIndexesSchema.safeParse(value);
	return parsed.success ? Array.from(new Set(parsed.data)) : [];
}
