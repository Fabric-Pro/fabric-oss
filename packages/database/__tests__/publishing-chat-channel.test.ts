import { expect, it } from "vitest";
import { publishingChatChannelSchema } from "../src/publishing-chat-channel";

it("accepts a well-formed target triple", () => {
	const parsed = publishingChatChannelSchema.safeParse({
		platform: "SLACK",
		teamId: "T-example",
		channelId: "C-example",
		channelName: "release-notes",
	});
	expect(parsed.success).toBe(true);
});

it("accepts a target with no display label", () => {
	// channelName is display-only and denormalized; the triple is authoritative
	// and is re-resolved against the live linked set before anything is posted.
	// A stored target that predates the label must stay valid.
	const parsed = publishingChatChannelSchema.safeParse({
		platform: "TEAMS",
		teamId: "T-example",
		channelId: "C-example",
	});
	expect(parsed.success).toBe(true);
});

it("rejects a platform the delivery path has no branch for", () => {
	const parsed = publishingChatChannelSchema.safeParse({
		platform: "DISCORD",
		teamId: "T-example",
		channelId: "C-example",
	});
	expect(parsed.success).toBe(false);
});

it("rejects an empty channel id", () => {
	// An empty string is not a channel: it would be persisted, then silently fail
	// to match anything in the live linked set, and read as a skipped target
	// rather than as the malformed input it is.
	const parsed = publishingChatChannelSchema.safeParse({
		platform: "SLACK",
		teamId: "T-example",
		channelId: "",
	});
	expect(parsed.success).toBe(false);
});
