import { describe, expect, it } from "vitest";
import {
	type BacklogContextAnalysisInput,
	isMeetingOnlyAnalysis,
	planTeamsFetch,
} from "../src/workflows/backlog-context-analysis-workflow";

describe("planTeamsFetch", () => {
	it("returns scoped plan when selectedChannelContextIds is non-empty", () => {
		const plan = planTeamsFetch({
			fetchTeamsMessages: false,
			selectedChannelContextIds: ["ctx-1", "ctx-2"],
		});
		expect(plan).toEqual({
			kind: "scoped",
			contextIds: ["ctx-1", "ctx-2"],
		});
	});

	it("scoped plan wins even when fetchTeamsMessages is also true", () => {
		const plan = planTeamsFetch({
			fetchTeamsMessages: true,
			selectedChannelContextIds: ["ctx-1"],
		});
		expect(plan.kind).toBe("scoped");
	});

	it("returns legacy plan when selectedChannelContextIds is empty and fetchTeamsMessages is true", () => {
		expect(
			planTeamsFetch({
				fetchTeamsMessages: true,
				selectedChannelContextIds: [],
			}),
		).toEqual({ kind: "legacy" });
	});

	it("returns legacy plan when selectedChannelContextIds is undefined and fetchTeamsMessages is true", () => {
		expect(
			planTeamsFetch({
				fetchTeamsMessages: true,
			}),
		).toEqual({ kind: "legacy" });
	});

	it("returns skip plan when both are absent/false", () => {
		expect(
			planTeamsFetch({
				fetchTeamsMessages: false,
				selectedChannelContextIds: [],
			}),
		).toEqual({ kind: "skip" });
		expect(
			planTeamsFetch({
				fetchTeamsMessages: false,
			}),
		).toEqual({ kind: "skip" });
	});
});

describe("isMeetingOnlyAnalysis", () => {
	const meetings = [{ joinUrl: "https://example.com/meeting" }];
	it.each<[string, BacklogContextAnalysisInput["contextSources"], boolean]>([
		[
			"meetings only",
			{ fetchTeamsMessages: false, selectedMeetings: meetings },
			true,
		],
		[
			"empty optional selections",
			{
				fetchTeamsMessages: false,
				selectedMeetings: meetings,
				selectedChannelContextIds: [],
				notionPageIds: [],
				fetchSlackMessages: false,
			},
			true,
		],
		[
			"Teams flag",
			{ fetchTeamsMessages: true, selectedMeetings: meetings },
			false,
		],
		[
			"selected channels",
			{
				fetchTeamsMessages: false,
				selectedMeetings: meetings,
				selectedChannelContextIds: ["example-channel"],
			},
			false,
		],
		[
			"explicit Slack",
			{
				fetchTeamsMessages: false,
				selectedMeetings: meetings,
				fetchSlackMessages: true,
			},
			false,
		],
		[
			"Notion pages without config",
			{
				fetchTeamsMessages: false,
				selectedMeetings: meetings,
				notionPageIds: ["example-page"],
			},
			false,
		],
		[
			"Notion pages with config",
			{
				fetchTeamsMessages: false,
				selectedMeetings: meetings,
				notionPageIds: ["example-page"],
				notionMcpConfigId: "example-config",
			},
			false,
		],
		["no meetings", { fetchTeamsMessages: false }, false],
		[
			"empty meetings",
			{ fetchTeamsMessages: false, selectedMeetings: [] },
			false,
		],
	])("%s", (_label, sources, expected) => {
		expect(isMeetingOnlyAnalysis(sources)).toBe(expected);
	});
});
