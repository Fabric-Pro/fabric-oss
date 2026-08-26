/**
 * Regression guard for issues #2525 and #2255: a Microsoft account that is
 * simply not connected yet is an ordinary, expected user state — the request
 * still returns 200 — but these activities used to log it at `error`, which
 * pollutes prod error-level monitoring with noise. Genuinely unexpected
 * Graph failures must keep logging at `error`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMicrosoftTeamsToolMock = vi.fn();
const findManyMock = vi.fn();

// The barrel is mocked because it reaches for `db` and crypto on import, but
// the not-connected classifier is deliberately dependency-free and lives in its
// own module — so pull in the REAL one rather than re-implementing it here. A
// mirrored copy would keep these tests green if the real classifier changed,
// which is precisely the regression they exist to catch.
vi.mock("@repo/integrations/microsoft", async () => {
	const { isMicrosoftNotConnectedError } = await vi.importActual<
		typeof import("@repo/integrations/microsoft/connection-errors")
	>("@repo/integrations/microsoft/connection-errors");

	return {
		executeMicrosoftTeamsTool: (...args: unknown[]) =>
			executeMicrosoftTeamsToolMock(...args),
		TEAMS_TOOL_LIMITS: {
			EXCERPTS_PER_PASS: 8,
			MAX_EXCERPTS_MERGED: 16,
			MAX_CHARS_PER_EXCERPT: 400,
			EXTRACTOR_TIMEOUT_MS: 15_000,
			FULL_MESSAGE_MAX_CHARS: 10_000,
		},
		isMicrosoftNotConnectedError,
	};
});

vi.mock("@repo/database", () => ({
	db: {
		projectContext: {
			findMany: (...args: unknown[]) => findManyMock(...args),
		},
	},
}));

vi.mock("@repo/ai", () => ({
	extractRelevantExcerpts: vi.fn(async () => ({ excerpts: [] })),
}));

import {
	fetchRecentTeamsMessages,
	searchProjectTeamsMessages,
} from "../search-project-teams-messages";

const NOT_CONNECTED_MESSAGE =
	"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.";
const GENUINE_ERROR_MESSAGE =
	"Microsoft Graph API error: 500 Internal Server Error - {}";

function singleChatContext(displayName = "Example Chat") {
	return [
		{
			id: "ctx-1",
			content: null,
			metadata: {
				provider: "MICROSOFT_TEAMS",
				chatId: "chat-1",
				chatTopic: displayName,
			},
		},
	];
}

describe("searchProjectTeamsMessages — log level (#2525)", () => {
	beforeEach(() => {
		executeMicrosoftTeamsToolMock.mockReset();
		findManyMock.mockReset().mockResolvedValue(singleChatContext());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("logs the not-connected failure at warn, not error", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		executeMicrosoftTeamsToolMock.mockRejectedValue(
			new Error(NOT_CONNECTED_MESSAGE),
		);

		const result = await searchProjectTeamsMessages({
			projectId: "p1",
			query: "release notes",
			userId: "u1",
			organizationId: "o1",
		});

		expect(errorSpy).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(String(warnSpy.mock.calls[0][0])).toContain(
			"Microsoft not connected",
		);
		// Control flow (the pushed error string) is unchanged by the level fix.
		expect(result.errors).toEqual([
			"Microsoft account not connected. Please connect your Microsoft account in Settings > Integrations.",
		]);
	});

	it("still logs a genuinely unexpected Graph failure at error", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		executeMicrosoftTeamsToolMock.mockRejectedValue(
			new Error(GENUINE_ERROR_MESSAGE),
		);

		const result = await searchProjectTeamsMessages({
			projectId: "p1",
			query: "release notes",
			userId: "u1",
			organizationId: "o1",
		});

		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).not.toHaveBeenCalled();
		expect(result.errors).toEqual([
			`Failed to search Teams messages: ${GENUINE_ERROR_MESSAGE}`,
		]);
	});
});

describe("fetchRecentTeamsMessages — not-connected warn dedup (#2255)", () => {
	beforeEach(() => {
		executeMicrosoftTeamsToolMock.mockReset();
		findManyMock.mockReset().mockResolvedValue([
			{
				id: "ctx-1",
				metadata: {
					provider: "MICROSOFT_TEAMS",
					chatId: "chat-1",
					chatTopic: "Example Chat One",
				},
			},
			{
				id: "ctx-2",
				metadata: {
					provider: "MICROSOFT_TEAMS",
					chatId: "chat-2",
					chatTopic: "Example Chat Two",
				},
			},
			{
				id: "ctx-3",
				metadata: {
					provider: "MICROSOFT_TEAMS",
					chatId: "chat-3",
					chatTopic: "Example Chat Three",
				},
			},
		]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits exactly one warn across contexts that all fail not-connected, but one errors entry per context", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		executeMicrosoftTeamsToolMock.mockRejectedValue(
			new Error(NOT_CONNECTED_MESSAGE),
		);

		const result = await fetchRecentTeamsMessages({
			projectId: "p1",
			userId: "u1",
			organizationId: "o1",
		});

		// One Microsoft account backs every configured chat/channel, so a single
		// polling cycle used to log the identical not-connected line once per
		// context (5-7 times in practice, #2255). It must collapse to one.
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).not.toHaveBeenCalled();
		// The errors array is unaffected by the log dedup — every context still
		// contributes its own entry.
		expect(result.errors).toHaveLength(3);
		expect(result.errors).toEqual([
			`Failed to fetch from Example Chat One: ${NOT_CONNECTED_MESSAGE}`,
			`Failed to fetch from Example Chat Two: ${NOT_CONNECTED_MESSAGE}`,
			`Failed to fetch from Example Chat Three: ${NOT_CONNECTED_MESSAGE}`,
		]);
	});

	it("logs a genuine error per context, unsuppressed", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		executeMicrosoftTeamsToolMock.mockRejectedValue(
			new Error(GENUINE_ERROR_MESSAGE),
		);

		const result = await fetchRecentTeamsMessages({
			projectId: "p1",
			userId: "u1",
			organizationId: "o1",
		});

		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledTimes(3);
		expect(result.errors).toHaveLength(3);
	});
});
