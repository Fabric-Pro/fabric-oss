import { describe, expect, it } from "vitest";
import { reporterSourceForProposal } from "../channel-monitor-source";

describe("reporterSourceForProposal", () => {
	it.each([
		["TEAMS_CHANNEL", "TEAMS"],
		["TEAMS_CHAT", "TEAMS"],
		["SLACK_CHANNEL", "SLACK"],
		["MONITORED_MEETING", null],
		["AI_UPDATE_SIDEBAR", null],
		["SCOPE_DOCUMENT", null],
		["ROADMAP_RECOMMENDATION", null],
		["LOG_MONITOR", null],
		["INCIDENT_CLUSTER", null],
		[null, null],
	])("reports a %s proposal as %s", (source, expected) => {
		expect(reporterSourceForProposal(source)).toBe(expected);
	});
});
