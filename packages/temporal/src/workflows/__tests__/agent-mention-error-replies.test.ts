import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	loadTriggerConfig: vi.fn(),
	loadSlackThreadMapping: vi.fn(),
	loadTeamsThreadMapping: vi.fn(),
	invokeAgent: vi.fn(),
	postToSlack: vi.fn(),
	postToTeams: vi.fn(),
	saveSlackThreadMappingContext: vi.fn(),
	saveTeamsThreadMappingContext: vi.fn(),
	updateTriggerStats: vi.fn(),
	patched: vi.fn(),
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
	patched: stubs.patched,
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
	stubs.patched.mockReturnValue(true);
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

describe("Slack mention handler reply delivery in trigger stats", () => {
	it.each([
		{ kind: "failed", post: { success: false, error: "not_in_channel" } },
		{ kind: "skipped", post: { success: true, skipped: true } },
	])("passes a $kind reply post as the delivery", async ({ post }) => {
		stubs.invokeAgent.mockResolvedValue({
			success: true,
			response: "Example reply",
			projectId: "project1",
		});
		stubs.postToSlack.mockResolvedValue(post);
		// Deliver one real signal, then cancel when the workflow waits again.
		stubs.condition
			.mockImplementationOnce(async (predicate: () => boolean) => {
				stubs.handlers.get("slackMention")?.(EVENT);
				expect(predicate()).toBe(true);
			})
			.mockImplementationOnce(async (predicate: () => boolean) => {
				stubs.handlers.get("cancel")?.();
				expect(predicate()).toBe(true);
			});

		await slackMentionHandlerWorkflow({
			triggerId: "trigger1",
			workspaceId: "team1",
			botUserId: "bot1",
			userId: "u1",
			organizationId: "org1",
		});

		expect(stubs.postToSlack).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				channel: "channel1",
				message: "Example reply",
				organizationId: "org1",
			}),
		);
		expect(stubs.updateTriggerStats).toHaveBeenCalledExactlyOnceWith({
			triggerId: "trigger1",
			lastTriggeredAt: expect.any(String),
			success: true,
			delivery: post,
			userId: "u1",
			organizationId: "org1",
		});
	});
});

for (const provider of ["Slack", "Teams"] as const) {
	describe(`${provider} mention handler undelivered reply`, () => {
		const SECOND_EVENT = {
			...EVENT,
			eventId: "event2",
			text: "Any update?",
			ts: "1.3",
		};
		const PERSON_TURN = { role: "user", content: "Please help", ts: "1.2" };
		const FIRST_REPLY = {
			role: "assistant",
			content: "First reply",
			ts: expect.any(String),
		};
		const SECOND_TURNS = [
			{ role: "user", content: "Any update?", ts: "1.3" },
			{ role: "assistant", content: "Second reply", ts: "1.4" },
		];
		const save = () =>
			provider === "Slack"
				? stubs.saveSlackThreadMappingContext
				: stubs.saveTeamsThreadMappingContext;
		const post = () =>
			provider === "Slack" ? stubs.postToSlack : stubs.postToTeams;

		/**
		 * Two mentions in one thread; the first reply post gets
		 * `firstPost`, the second is delivered. Returns each saved history
		 * as it was when saved (the workflow keeps mutating the array).
		 */
		async function runTwoMentions(firstPost: object) {
			const saved: unknown[] = [];
			save().mockImplementation(
				async ({
					conversationHistory,
				}: {
					conversationHistory: unknown[];
				}) => {
					saved.push(structuredClone(conversationHistory));
					return { success: true };
				},
			);
			stubs.loadSlackThreadMapping.mockResolvedValue({
				mapping: { id: "mapping1" },
				conversationHistory: [],
			});
			stubs.loadTeamsThreadMapping.mockResolvedValue({
				mapping: { id: "mapping1" },
				conversationHistory: [],
			});
			stubs.invokeAgent
				.mockResolvedValueOnce({
					success: true,
					response: "First reply",
					executionId: "execution1",
				})
				.mockResolvedValueOnce({
					success: true,
					response: "Second reply",
					executionId: "execution2",
				});
			post()
				.mockResolvedValueOnce(firstPost)
				.mockResolvedValueOnce(
					provider === "Slack"
						? { success: true, messageTs: "1.4" }
						: { success: true, messageId: "1.4" },
				);
			// Deliver both mentions, then cancel when the workflow waits again.
			stubs.condition
				.mockImplementationOnce(async (predicate: () => boolean) => {
					const mention = stubs.handlers.get(
						provider === "Slack" ? "slackMention" : "teamsMention",
					);
					mention?.(EVENT);
					mention?.(SECOND_EVENT);
					expect(predicate()).toBe(true);
				})
				.mockImplementationOnce(async (predicate: () => boolean) => {
					stubs.handlers.get("cancel")?.();
					expect(predicate()).toBe(true);
				});

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

			expect(save()).toHaveBeenCalledTimes(2);
			expect(save().mock.calls.map(([args]) => args.mappingId)).toEqual([
				"mapping1",
				"mapping1",
			]);
			expect(stubs.updateTriggerStats).toHaveBeenCalledTimes(2);
			// The history is saved before the stats, as before.
			expect(save().mock.invocationCallOrder[0]).toBeLessThan(
				stubs.updateTriggerStats.mock.invocationCallOrder[0],
			);
			return saved;
		}

		const ended = () =>
			stubs.log.info.mock.calls.find(
				([message]) =>
					message === `${provider} mention handler workflow ended`,
			)?.[1];
		const processedEvents = () =>
			stubs.log.info.mock.calls
				.filter(
					([message]) =>
						message ===
						`${provider} mention processed successfully`,
				)
				.map(([, details]) => details.eventId);

		it("keeps an undelivered reply out of the history and the processed count", async () => {
			const saved = await runTwoMentions({
				success: false,
				error: "not_in_channel",
			});

			// The person's turn stays, so the next mention sees what was asked.
			expect(saved).toEqual([
				[PERSON_TURN],
				[PERSON_TURN, ...SECOND_TURNS],
			]);
			expect(
				stubs.invokeAgent.mock.calls[1][0].conversationHistory,
			).toEqual([{ role: "user", content: "Please help" }]);
			expect(ended()).toMatchObject({ totalProcessed: 1 });
			expect(processedEvents()).toEqual(["event2"]);
			expect(stubs.log.warn).toHaveBeenCalledWith(
				`${provider} mention reply was not delivered`,
				expect.objectContaining({
					eventId: "event1",
					processedCount: 0,
					agentExecutionId: "execution1",
				}),
			);
		});

		it.each([
			{
				kind: "a skipped reply (Read-only project)",
				firstPost: { success: true, skipped: true },
				patchedIds: () => true,
			},
			{
				kind: "an undelivered reply in a history without the delivery marker",
				firstPost: { success: false, error: "not_in_channel" },
				patchedIds: (id: string) =>
					id !== "trigger-stats-delivery-outcome-2026-11",
			},
		])(
			"keeps $kind in the history and the processed count",
			async ({ firstPost, patchedIds }) => {
				stubs.patched.mockImplementation(patchedIds);

				const saved = await runTwoMentions(firstPost);

				expect(saved).toEqual([
					[PERSON_TURN, FIRST_REPLY],
					[PERSON_TURN, FIRST_REPLY, ...SECOND_TURNS],
				]);
				expect(
					stubs.invokeAgent.mock.calls[1][0].conversationHistory,
				).toEqual([
					{ role: "user", content: "Please help" },
					{ role: "assistant", content: "First reply" },
				]);
				expect(ended()).toMatchObject({ totalProcessed: 2 });
				expect(processedEvents()).toEqual(["event1", "event2"]);
				expect(stubs.log.warn).not.toHaveBeenCalledWith(
					`${provider} mention reply was not delivered`,
					expect.anything(),
				);
			},
		);
	});
}
