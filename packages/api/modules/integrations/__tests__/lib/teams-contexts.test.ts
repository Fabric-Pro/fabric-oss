/**
 * Tests for `parseTeamsContexts`, the metadata→context parsing shared by
 * `integrations.teams.getRecentMessages` and `integrations.teams.contextAccess`
 * (Fizzy #2450).
 *
 * Pins the missing-chatType warning: before the shared loop was extracted,
 * `getRecentTeamsMessages` logged
 * `[getRecentTeamsMessages] Context missing chatType, skipping` with
 * `{ contextId, projectId }`. The extraction must not silently change that
 * log line — a caller's `logTag` reproduces its own original prefix, and
 * `projectId` (not available inside the shared helper on its own) is passed
 * back in via the options argument.
 */

import { describe, expect, it, vi } from "vitest";
import { parseTeamsContexts } from "../../lib/teams-contexts";

describe("parseTeamsContexts", () => {
	it("logs the exact original getRecentTeamsMessages warning for a context missing chatType", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = parseTeamsContexts(
			[
				{
					id: "ctx-1",
					metadata: { provider: "MICROSOFT_TEAMS" /* no chatType */ },
				},
			],
			{ projectId: "proj_1", logTag: "getRecentTeamsMessages" },
		);

		expect(result).toEqual([]);
		expect(warnSpy).toHaveBeenCalledWith(
			"[getRecentTeamsMessages] Context missing chatType, skipping",
			{ contextId: "ctx-1", projectId: "proj_1" },
		);

		warnSpy.mockRestore();
	});

	it("uses the caller's own logTag for the same warning", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		parseTeamsContexts(
			[{ id: "ctx-2", metadata: { provider: "MICROSOFT_TEAMS" } }],
			{ projectId: "proj_2", logTag: "getTeamsContextAccess" },
		);

		expect(warnSpy).toHaveBeenCalledWith(
			"[getTeamsContextAccess] Context missing chatType, skipping",
			{ contextId: "ctx-2", projectId: "proj_2" },
		);

		warnSpy.mockRestore();
	});

	it("parses a chat context, carrying the ProjectContext row id", () => {
		const result = parseTeamsContexts(
			[
				{
					id: "ctx-3",
					metadata: {
						provider: "MICROSOFT_TEAMS",
						chatType: "chat",
						chatId: "chat-1",
						chatTopic: "example-team",
					},
				},
			],
			{ projectId: "proj_3", logTag: "getRecentTeamsMessages" },
		);

		expect(result).toEqual([
			{
				id: "ctx-3",
				type: "chat",
				chatId: "chat-1",
				displayName: "example-team",
			},
		]);
	});

	it("parses a channel context", () => {
		const result = parseTeamsContexts(
			[
				{
					id: "ctx-4",
					metadata: {
						provider: "MICROSOFT_TEAMS",
						chatType: "channel",
						teamId: "team-1",
						channelId: "channel-1",
						chatTopic: "General",
					},
				},
			],
			{ projectId: "proj_4", logTag: "getRecentTeamsMessages" },
		);

		expect(result).toEqual([
			{
				id: "ctx-4",
				type: "channel",
				teamId: "team-1",
				channelId: "channel-1",
				displayName: "General",
			},
		]);
	});

	it("skips a context for a different provider", () => {
		const result = parseTeamsContexts(
			[{ id: "ctx-5", metadata: { provider: "SLACK" } }],
			{ projectId: "proj_5", logTag: "getRecentTeamsMessages" },
		);

		expect(result).toEqual([]);
	});
});
