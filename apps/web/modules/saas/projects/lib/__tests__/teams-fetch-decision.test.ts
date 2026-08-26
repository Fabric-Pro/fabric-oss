import { describe, expect, it } from "vitest";
import { resolveTeamsFetchDecision } from "../teams-fetch-decision";

describe("resolveTeamsFetchDecision", () => {
	it("no selectedChannels at all → Teams fetch skipped", () => {
		// Covers the case where the agent calls analyze_backlog without ever
		// opening the selector (e.g. Slack-only, Notion-only, or meetings-only
		// flow where the LLM dropped all selector fields during marshaling).
		expect(resolveTeamsFetchDecision({})).toEqual({
			fetchTeamsMessages: false,
			selectedChannelContextIds: [],
		});
	});

	it("selectedChannels is explicitly empty → Teams fetch skipped", () => {
		// The user opened the selector and picked meetings only. Must not
		// fall through to fetching every linked channel.
		expect(resolveTeamsFetchDecision({ selectedChannels: [] })).toEqual({
			fetchTeamsMessages: false,
			selectedChannelContextIds: [],
		});
	});

	it("selectedChannels is non-empty → scoped fetch on exactly those IDs", () => {
		expect(
			resolveTeamsFetchDecision({
				selectedChannels: [
					{ projectContextId: "ctx-1" },
					{ projectContextId: "ctx-2" },
				],
			}),
		).toEqual({
			fetchTeamsMessages: true,
			selectedChannelContextIds: ["ctx-1", "ctx-2"],
		});
	});
});
