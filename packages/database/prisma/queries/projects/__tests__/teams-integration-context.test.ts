import { describe, expect, it } from "vitest";
import {
	buildTeamsChannelContextMetadata,
	buildTeamsChatContextMetadata,
	teamsChannelContextMatches,
	teamsChatContextMatches,
} from "../teams-integration-context";

describe("buildTeamsChannelContextMetadata", () => {
	it("builds a channel display name from team + channel names", () => {
		const meta = buildTeamsChannelContextMetadata({
			teamId: "t1",
			channelId: "c1",
			teamName: "Fabric Team",
			channelName: "General",
		});
		expect(meta).toMatchObject({
			provider: "MICROSOFT_TEAMS",
			chatType: "channel",
			teamId: "t1",
			channelId: "c1",
			teamName: "Fabric Team",
			channelName: "General",
			chatName: "General",
			chatTopic: "Fabric Team - General",
		});
	});

	it("falls back to channel name, then team name, then a generic label", () => {
		expect(
			buildTeamsChannelContextMetadata({
				teamId: "t1",
				channelId: "c1",
				channelName: "General",
			}).chatTopic,
		).toBe("General");
		expect(
			buildTeamsChannelContextMetadata({
				teamId: "t1",
				channelId: "c1",
				teamName: "Fabric Team",
			}).chatTopic,
		).toBe("Fabric Team");
		expect(
			buildTeamsChannelContextMetadata({ teamId: "t1", channelId: "c1" })
				.chatTopic,
		).toBe("Teams channel");
	});

	it("omits absent name keys instead of writing undefined", () => {
		const meta = buildTeamsChannelContextMetadata({
			teamId: "t1",
			channelId: "c1",
		});
		expect("channelName" in meta).toBe(false);
		expect("teamName" in meta).toBe(false);
		expect("chatName" in meta).toBe(false);
	});
});

describe("buildTeamsChatContextMetadata", () => {
	it("uses the chat topic, defaulting when absent", () => {
		expect(
			buildTeamsChatContextMetadata({
				chatId: "g1",
				chatTopic: "Action Team",
			}),
		).toMatchObject({
			provider: "MICROSOFT_TEAMS",
			chatType: "group",
			chatId: "g1",
			chatTopic: "Action Team",
		});
		expect(buildTeamsChatContextMetadata({ chatId: "g1" }).chatTopic).toBe(
			"Teams group chat",
		);
	});

	it("supports 1:1 direct chats and sets metadata chatType to oneOnOne", () => {
		expect(
			buildTeamsChatContextMetadata({
				chatId: "d1",
				chatTopic: "1:1 with Jane Doe",
				chatType: "oneOnOne",
			}),
		).toMatchObject({
			provider: "MICROSOFT_TEAMS",
			chatType: "oneOnOne",
			chatId: "d1",
			chatTopic: "1:1 with Jane Doe",
		});

		expect(
			buildTeamsChatContextMetadata({
				chatId: "d1",
				chatType: "oneOnOne",
			}).chatTopic,
		).toBe("1:1 Direct Chat");
	});
});

describe("teamsChannelContextMatches", () => {
	const meta = buildTeamsChannelContextMetadata({
		teamId: "t1",
		channelId: "c1",
	});
	it("matches on provider + teamId + channelId", () => {
		expect(
			teamsChannelContextMatches(meta, { teamId: "t1", channelId: "c1" }),
		).toBe(true);
	});
	it("rejects a different channel, wrong provider, or non-object", () => {
		expect(
			teamsChannelContextMatches(meta, {
				teamId: "t1",
				channelId: "other",
			}),
		).toBe(false);
		expect(
			teamsChannelContextMatches(
				{ provider: "SLACK", teamId: "t1", channelId: "c1" },
				{ teamId: "t1", channelId: "c1" },
			),
		).toBe(false);
		expect(
			teamsChannelContextMatches(null, { teamId: "t1", channelId: "c1" }),
		).toBe(false);
	});
});

describe("teamsChatContextMatches", () => {
	const meta = buildTeamsChatContextMetadata({ chatId: "g1" });
	it("matches on provider + chatId", () => {
		expect(teamsChatContextMatches(meta, { chatId: "g1" })).toBe(true);
		expect(teamsChatContextMatches(meta, { chatId: "other" })).toBe(false);
		expect(teamsChatContextMatches("nope", { chatId: "g1" })).toBe(false);
	});
});
