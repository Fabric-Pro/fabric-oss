import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	loadTriggerConfig: vi.fn(),
	loadSlackThreadMapping: vi.fn(),
	loadTeamsThreadMapping: vi.fn(),
	invokeAgent: vi.fn(),
	postToSlack: vi.fn(),
	postToTeams: vi.fn(),
	updateTriggerStats: vi.fn(),
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	condition: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: () => stubs,
	defineSignal: (name: string) => name,
	defineQuery: (name: string) => name,
	setHandler: (name: string, handler: (...args: unknown[]) => unknown) =>
		stubs.handlers.set(name, handler),
	condition: stubs.condition,
	patched: () => true,
	sleep: () => new Promise(() => {}),
	workflowInfo: () => ({ continueAsNewSuggested: false }),
	continueAsNew: vi.fn(),
	ApplicationFailure: class extends Error {},
	log: stubs.log,
}));

import { teamsMentionHandlerWorkflow } from "../teams-mention-handler";
import { slackMentionHandlerWorkflow } from "../trigger-system/index";

const LIMIT_ERROR =
	"AI usage limit exceeded: limit_abc (TOKENS, DAILY) — used 120000 of 100000";
const USAGE_LIMIT = {
	message: LIMIT_ERROR,
	limitId: "limit_abc",
	dimension: "TOKENS" as const,
	window: "DAILY" as const,
	used: "120000",
	max: "100000",
	manageLimitsUrl: "/settings/ai/limits",
};
const EVENT = {
	eventId: "event1",
	channel: "channel1",
	teamId: "team1",
	channelId: "channel1",
	chatId: "chat1",
	messageId: "message1",
	threadId: "thread1",
	threadTs: "1.1",
	text: "Please help",
	ts: "1.2",
	user: { id: "u2", name: "Example user" },
	isMention: true,
};

beforeEach(() => {
	vi.resetAllMocks();
	stubs.handlers.clear();
	stubs.loadTriggerConfig.mockResolvedValue({
		status: "ACTIVE",
		agentId: "agent1",
	});
	stubs.loadSlackThreadMapping.mockResolvedValue({ conversationHistory: [] });
	stubs.loadTeamsThreadMapping.mockResolvedValue({ conversationHistory: [] });
	stubs.postToSlack.mockResolvedValue({ success: true });
	stubs.postToTeams.mockResolvedValue({ success: true });
});

for (const provider of ["Slack", "Teams"] as const) {
	describe(`${provider} mention handler failure replies`, () => {
		it.each([
			{
				kind: "generic error",
				error: "upstream 529: overloaded_error request_id=req_example",
				usageLimit: undefined,
				message: "Sorry, I ran into an error and couldn't respond.",
			},
			{
				kind: "usage-limit refusal",
				error: LIMIT_ERROR,
				usageLimit: USAGE_LIMIT,
				message:
					"Sorry, I couldn't respond: an AI usage limit was reached.",
			},
		])(
			"posts safe text for a $kind",
			async ({ error, usageLimit, message }) => {
				stubs.invokeAgent.mockResolvedValue({
					success: false,
					response: "",
					error,
					usageLimit,
					projectId: "project1",
				});
				// Deliver one real signal, then cancel when the workflow waits again.
				stubs.condition
					.mockImplementationOnce(
						async (predicate: () => boolean) => {
							stubs.handlers.get(
								provider === "Slack"
									? "slackMention"
									: "teamsMention",
							)?.(EVENT);
							expect(predicate()).toBe(true);
						},
					)
					.mockImplementationOnce(
						async (predicate: () => boolean) => {
							stubs.handlers.get("cancel")?.();
							expect(predicate()).toBe(true);
						},
					);

				if (provider === "Slack") {
					await slackMentionHandlerWorkflow({
						triggerId: "trigger1",
						workspaceId: "team1",
						botUserId: "bot1",
						userId: "u1",
						organizationId: "org1",
					});
				} else {
					await teamsMentionHandlerWorkflow({
						deploymentId: "agent1",
						teamId: "team1",
						channelId: "channel1",
						userId: "u1",
						organizationId: "org1",
					});
				}

				const post =
					provider === "Slack"
						? stubs.postToSlack
						: stubs.postToTeams;
				expect(post).toHaveBeenCalledTimes(1);
				const reply = post.mock.calls[0][0];
				expect(reply.message).not.toContain(error);
				expect(reply.message).toBe(message);
				for (const detail of ["limit_abc", "120000", "100000"]) {
					expect(JSON.stringify(reply)).not.toContain(detail);
				}
				expect(reply).toMatchObject({
					organizationId: "org1",
					projectId: "project1",
					...(provider === "Slack"
						? {
								channel: "channel1",
								threadTs: "1.1",
								slackTeamId: "team1",
							}
						: {
								teamId: "team1",
								channelId: "channel1",
								chatId: "chat1",
								messageId: "message1",
							}),
				});
				expect(stubs.invokeAgent).toHaveBeenCalledTimes(1);
				expect(stubs.invokeAgent).toHaveBeenCalledWith(
					expect.objectContaining({ organizationId: "org1" }),
				);
				expect(stubs.log.error).toHaveBeenCalledExactlyOnceWith(
					"Agent invocation failed",
					{ eventId: "event1", error },
				);
				expect(
					stubs.updateTriggerStats,
				).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						success: false,
						error,
						organizationId: "org1",
					}),
				);
				expect(
					stubs.invokeAgent.mock.invocationCallOrder[0],
				).toBeLessThan(post.mock.invocationCallOrder[0]);
				expect(post.mock.invocationCallOrder[0]).toBeLessThan(
					stubs.updateTriggerStats.mock.invocationCallOrder[0],
				);
			},
		);
	});
}
