import { z } from "zod";

/** Chat platforms the Publishing Suite can broadcast topic suggestions to,
 *  reusing the existing OAuth connected-channel integrations. */
export const PUBLISHING_CHAT_PLATFORMS = ["TEAMS", "SLACK"] as const;
export type PublishingChatPlatform = (typeof PUBLISHING_CHAT_PLATFORMS)[number];

/**
 * A selected broadcast target, persisted as JSON on
 * `PublishingSuiteSettings.chatChannels`. `teamId` is the Teams `teamId` OR the
 * Slack `slackTeamId`; `channelName` is a denormalized label for display only —
 * the (platform, teamId, channelId) triple is authoritative and is re-resolved
 * against the live linked-channel set before anything is posted.
 *
 * STRUCTURALLY IDENTICAL to `newsletterChatChannelSchema`, and deliberately not
 * shared with it. This schema governs a PERSISTED payload: two features whose
 * settings rows were written at different times have to be able to evolve their
 * wire contracts independently. Sharing one schema means a widening made for the
 * newsletter silently widens what this column accepts, and a narrowing made here
 * would invalidate stored newsletter rows — a coupling with no upside, since the
 * two are never read together.
 */
export const publishingChatChannelSchema = z.object({
	platform: z.enum(PUBLISHING_CHAT_PLATFORMS),
	teamId: z.string().min(1),
	channelId: z.string().min(1),
	channelName: z.string().optional(),
});
export type PublishingChatChannel = z.infer<typeof publishingChatChannelSchema>;
