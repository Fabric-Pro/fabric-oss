/**
 * Unit tests for `normalizeChange` epic→feature normalization (Bug 1429).
 *
 * `BacklogChangeProposal` is SHARED between two flows:
 *   - the channel-monitor (Teams/Slack) pending-proposal inbox, which is
 *     feature/bug-only and passes `forbidEpics`; and
 *   - the general AI Update flow (BacklogChat), where `epic` is first-class.
 *
 * So the epic→feature map MUST be gated on the `forbidEpics` argument:
 * `normalizeChange(raw, true)` maps `epic → feature` (channel-monitor); the
 * default `normalizeChange(raw)` / `normalizeChange(raw, false)` KEEPS `epic`
 * so general epic creation is preserved (Codex P1 regression guard).
 */

import { describe, expect, it } from "vitest";
import { deriveDefaultKind, normalizeChange } from "../BacklogChangeProposal";

describe("normalizeChange — epic normalization scoped to forbidEpics (Bug 1429 / Codex P1)", () => {
	it("with forbidEpics=true, maps a stored type:'epic' proposal to type:'feature'", () => {
		const result = normalizeChange(
			{
				type: "epic",
				action: "create",
				title: { to: "Mobile App Launch" },
				reasoning: "stored pre-fix proposal",
				sourceContext: "teams_messages",
			},
			true,
		);
		expect(result.type).toBe("feature");
	});

	it("with forbidEpics=true, the normalized epic derives kind FEATURE for the toggle", () => {
		const result = normalizeChange(
			{
				type: "epic",
				action: "create",
				title: { to: "Enterprise SSO" },
				reasoning: "stored pre-fix proposal",
				sourceContext: "slack_messages",
			},
			true,
		);
		expect(deriveDefaultKind(result.type)).toBe("FEATURE");
	});

	it("with forbidEpics=true, handles capitalized 'Epic' too", () => {
		const result = normalizeChange(
			{
				type: "Epic",
				action: "create",
				title: { to: "Big Initiative" },
				reasoning: "stored pre-fix proposal",
				sourceContext: "teams_messages",
			},
			true,
		);
		expect(result.type).toBe("feature");
	});

	it("DEFAULT (no flag) KEEPS type:'epic' — general AI Update flow preserves epics", () => {
		const result = normalizeChange({
			type: "epic",
			action: "create",
			title: { to: "Mobile App Launch" },
			reasoning: "general AI Update proposal",
			sourceContext: "meeting_transcript",
		});
		expect(result.type).toBe("epic");
	});

	it("forbidEpics=false (explicit) KEEPS type:'epic'", () => {
		const result = normalizeChange(
			{
				type: "epic",
				action: "create",
				title: { to: "Enterprise SSO" },
				reasoning: "general AI Update proposal",
				sourceContext: "meeting_transcript",
			},
			false,
		);
		expect(result.type).toBe("epic");
	});

	it("does NOT touch a normal feature proposal (either flag value)", () => {
		expect(
			normalizeChange({
				type: "feature",
				action: "create",
				title: { to: "Export to CSV" },
				reasoning: "normal",
				sourceContext: "teams_messages",
			}).type,
		).toBe("feature");
		expect(
			normalizeChange(
				{
					type: "feature",
					action: "create",
					title: { to: "Export to CSV" },
					reasoning: "normal",
					sourceContext: "teams_messages",
				},
				true,
			).type,
		).toBe("feature");
	});

	it("does NOT touch a bug proposal (either flag value)", () => {
		expect(
			normalizeChange({
				type: "bug",
				action: "create",
				title: { to: "Crash on save" },
				reasoning: "normal",
				sourceContext: "teams_messages",
			}).type,
		).toBe("bug");
		expect(
			normalizeChange(
				{
					type: "bug",
					action: "create",
					title: { to: "Crash on save" },
					reasoning: "normal",
					sourceContext: "teams_messages",
				},
				true,
			).type,
		).toBe("bug");
	});
});
