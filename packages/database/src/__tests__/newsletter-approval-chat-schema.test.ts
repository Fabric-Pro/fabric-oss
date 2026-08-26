import { describe, expect, it } from "vitest";
import {
	NEWSLETTER_CHAT_DELIVERY_KINDS,
	newsletterApprovalChatChannelSchema,
} from "../newsletter-schema";

describe("newsletterApprovalChatChannelSchema", () => {
	it("accepts a fully specified Slack target", () => {
		const parsed = newsletterApprovalChatChannelSchema.parse({
			platform: "SLACK",
			teamId: "T-example",
			channelId: "C-example",
			channelName: "releases",
		});
		expect(parsed.platform).toBe("SLACK");
		expect(parsed.channelName).toBe("releases");
	});

	it("accepts a target without the display-only channelName", () => {
		const parsed = newsletterApprovalChatChannelSchema.parse({
			platform: "TEAMS",
			teamId: "team-example",
			channelId: "channel-example",
		});
		expect(parsed.channelName).toBeUndefined();
	});

	it("rejects an empty channelId, which would claim a bogus ledger row", () => {
		expect(() =>
			newsletterApprovalChatChannelSchema.parse({
				platform: "SLACK",
				teamId: "T-example",
				channelId: "",
			}),
		).toThrow();
	});

	it("rejects an unknown platform spelling", () => {
		expect(() =>
			newsletterApprovalChatChannelSchema.parse({
				platform: "MICROSOFT_TEAMS",
				teamId: "team-example",
				channelId: "channel-example",
			}),
		).toThrow();
	});

	it("exposes exactly the two delivery kinds", () => {
		expect(NEWSLETTER_CHAT_DELIVERY_KINDS).toEqual(["CONTENT", "APPROVAL"]);
	});
});
