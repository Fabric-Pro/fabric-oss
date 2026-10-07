/**
 * Advisor Stop during the search_teams_messages tool.
 *
 * The activity caught every failure and returned an empty result with an
 * error line, so a stopped chat turn's refused or aborted relevance-extractor
 * request became tool output and the turn went on. In a chat turn
 * (`turnScope`) a stop leaves the activity; with no turn the error result is
 * unchanged.
 */

import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeMicrosoftTeamsTool: vi.fn(),
	extractRelevantExcerpts: vi.fn(),
	findMany: vi.fn(),
	checkDispatchable: vi.fn(),
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: mocks.executeMicrosoftTeamsTool,
	TEAMS_TOOL_LIMITS: {
		EXCERPTS_PER_PASS: 8,
		MAX_EXCERPTS_MERGED: 16,
		MAX_CHARS_PER_EXCERPT: 400,
		EXTRACTOR_TIMEOUT_MS: 15_000,
		FULL_MESSAGE_MAX_CHARS: 10_000,
	},
	isMicrosoftAccessDeniedError: () => false,
	isMicrosoftNotConnectedError: () => false,
}));

vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: mocks.checkDispatchable,
	db: { projectContext: { findMany: mocks.findMany } },
}));

vi.mock("@repo/ai", () => ({
	extractRelevantExcerpts: mocks.extractRelevantExcerpts,
}));

import {
	isTurnNotDispatchable,
	runWithTurnDispatch,
} from "../orchestrator/turn-dispatch";
import { searchProjectTeamsMessages } from "../search-project-teams-messages";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

const INPUT = {
	projectId: "project-1",
	query: "launch date",
	userId: TURN_SCOPE.userId,
	organizationId: TURN_SCOPE.organizationId,
};

function turnStopped() {
	return ApplicationFailure.create({
		type: "TurnNotDispatchable",
		message: "Turn turn-example-1 may not make another model request",
		nonRetryable: true,
		details: [{ reason: "cancelled" }],
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findMany.mockResolvedValue([
		{
			id: "ctx-1",
			content: null,
			metadata: {
				provider: "MICROSOFT_TEAMS",
				chatId: "chat-1",
				chatTopic: "Example Chat",
			},
		},
	]);
	mocks.executeMicrosoftTeamsTool.mockResolvedValue({
		messages: [
			{
				id: "m1",
				content: "We launch on Friday.",
				from: "Example Person",
				chatId: "chat-1",
			},
		],
		count: 1,
	});
});

describe("searchProjectTeamsMessages", () => {
	it("rethrows a stop from the relevance extractor in a chat turn", async () => {
		const stop = turnStopped();
		mocks.extractRelevantExcerpts.mockRejectedValue(stop);

		await expect(
			searchProjectTeamsMessages({ ...INPUT, turnScope: TURN_SCOPE }),
		).rejects.toBe(stop);
	});

	it("aborts the other extractor pass in flight and returns only after it settles", async () => {
		// Two passes. Pass 1's check passes and its request is in flight;
		// the Stop is recorded and pass 2's check is refused.
		mocks.checkDispatchable
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValue({ ok: false, reason: "cancelled" });
		const events: string[] = [];
		let inFlight: AbortSignal | undefined;
		// Stands in for the extractor's factory-model request.
		mocks.extractRelevantExcerpts.mockImplementation(
			async (options: { toolName: string }) => {
				const guard = getDispatchGuard();
				if (options.toolName.endsWith("pass2")) {
					// Let pass 1's request get going first.
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				await guard?.assertDispatchable();
				const signal = guard?.abortSignal();
				inFlight = signal;
				return new Promise((_resolve, reject) => {
					const giveUp = () =>
						setTimeout(() => {
							events.push("sibling settled");
							reject(new DOMException("aborted", "AbortError"));
						}, 20);
					if (signal?.aborted) {
						giveUp();
					} else {
						signal?.addEventListener("abort", giveUp);
					}
				});
			},
		);

		const error = await runWithTurnDispatch(TURN_SCOPE, () =>
			searchProjectTeamsMessages({
				...INPUT,
				alternateQuery: "release date",
				turnScope: TURN_SCOPE,
			}),
		).catch((caught: unknown) => {
			events.push("activity settled");
			return caught;
		});

		expect(inFlight?.aborted).toBe(true);
		expect(events).toEqual(["sibling settled", "activity settled"]);
		expect(isTurnNotDispatchable(error)).toBe(true);
	});

	it("keeps the error result with no turn", async () => {
		mocks.extractRelevantExcerpts.mockRejectedValue(turnStopped());

		const result = await searchProjectTeamsMessages(INPUT);

		expect(result.totalCount).toBe(0);
		expect(result.errors[0]).toContain("Failed to search Teams messages");
	});
});
