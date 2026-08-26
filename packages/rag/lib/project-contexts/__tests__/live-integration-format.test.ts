/**
 * Live Teams/Slack message formatting for Context Source Type Labeling
 * (Fizzy #1888). The parent integration source's label/guidance ride on
 * each message and render as bracketed lines under the channel header.
 * Absent fields ⇒ byte-identical to pre-feature output.
 */
import { describe, expect, it } from "vitest";
import { formatLiveContextForPrompt } from "../live-integration-context";

function makeResult(messageOverrides: Record<string, unknown> = {}) {
	return {
		teamsMessages: [
			{
				id: "m1",
				content: "We settled on option B.",
				from: "Ana",
				createdAt: "2026-08-20T10:00:00Z",
				source: "Device Sync",
				...messageOverrides,
			},
		],
		slackMessages: [],
		teamsMessageCount: 1,
		slackMessageCount: 0,
		hasTeams: true,
		hasSlack: false,
	};
}

describe("formatLiveContextForPrompt — no metadata", () => {
	it("keeps the legacy message shape", () => {
		const out = formatLiveContextForPrompt(makeResult());
		expect(out).toContain("## Recent Microsoft Teams Discussions");
		expect(out).toContain("[Device Sync - ");
		expect(out).toContain("From: Ana");
		expect(out).not.toContain("[Source type:");
		expect(out).not.toContain("[Source guidance:");
	});
});

describe("formatLiveContextForPrompt — with metadata", () => {
	it("renders the label + guidance under the channel header", () => {
		const out = formatLiveContextForPrompt(
			makeResult({
				sourceLabel: "Client Chat",
				sourceGuidance: "Authoritative for device sync.",
			}),
		);
		expect(out).toContain("[Source type: Client Chat]");
		expect(out).toContain(
			"[Source guidance: Authoritative for device sync.]",
		);
		// Order: channel header, then metadata, then author, then content.
		const headerIdx = out.indexOf("[Device Sync - ");
		const metaIdx = out.indexOf("[Source type:");
		const fromIdx = out.indexOf("From: Ana");
		expect(headerIdx).toBeLessThan(metaIdx);
		expect(metaIdx).toBeLessThan(fromIdx);
	});

	it("renders only the guidance when no label is set", () => {
		const out = formatLiveContextForPrompt(
			makeResult({ sourceGuidance: "Weight highly." }),
		);
		expect(out).toContain("[Source guidance: Weight highly.]");
		expect(out).not.toContain("[Source type:");
	});
});
