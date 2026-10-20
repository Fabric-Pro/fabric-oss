import { describe, expect, it } from "vitest";
import {
	resolveSlackFetchDecision,
	type SlackFetchDecisionInput,
} from "../slack-fetch-decision";

describe("resolveSlackFetchDecision", () => {
	it.each<[string, SlackFetchDecisionInput, boolean]>([
		[
			"no selections with Slack linked",
			{ hasSlackIntegration: true },
			true,
		],
		[
			"empty selections with Slack linked",
			{
				hasSlackIntegration: true,
				selectedMeetings: [],
				selectedChannels: [],
				notionPageIds: [],
			},
			true,
		],
		[
			"meetings selected",
			{
				hasSlackIntegration: true,
				selectedMeetings: [{ joinUrl: "https://example.com/meeting" }],
			},
			false,
		],
		[
			"channels selected",
			{
				hasSlackIntegration: true,
				selectedChannels: [{ projectContextId: "example-channel" }],
			},
			true,
		],
		[
			"Notion selected",
			{ hasSlackIntegration: true, notionPageIds: ["example-page"] },
			true,
		],
		[
			"meetings and channels selected",
			{
				hasSlackIntegration: true,
				selectedMeetings: [{}],
				selectedChannels: [{ projectContextId: "example-channel" }],
			},
			true,
		],
		[
			"meetings and Notion selected",
			{
				hasSlackIntegration: true,
				selectedMeetings: [{}],
				notionPageIds: ["example-page"],
			},
			true,
		],
		[
			"explicit true with meetings",
			{
				hasSlackIntegration: true,
				fetchSlackMessages: true,
				selectedMeetings: [{}],
			},
			true,
		],
		[
			"explicit false",
			{ hasSlackIntegration: true, fetchSlackMessages: false },
			false,
		],
		["Slack not linked", { hasSlackIntegration: false }, false],
		[
			"explicit true without linked Slack",
			{ hasSlackIntegration: false, fetchSlackMessages: true },
			true,
		],
	])("%s", (_label, args, expected) => {
		expect(resolveSlackFetchDecision(args)).toBe(expected);
	});
});
