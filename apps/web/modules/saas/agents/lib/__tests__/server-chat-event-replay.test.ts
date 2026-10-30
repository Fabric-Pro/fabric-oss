import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createServerChatReplay,
	projectChatReplayEvent,
} from "../server/chat-event-replay";

const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@repo/database", () => ({
	readConversationTurnEvents: h.read,
	ChatEventReplayError: class ChatEventReplayError extends Error {},
}));
const scope = {
	turnId: "example-turn",
	runId: "example-run",
	executionId: "orch-example",
	organizationId: "example-org",
	userId: "example-user",
};
const row = (sequence: number) => ({
	event: "execution.text_delta",
	data: { text: String(sequence) },
	cursor: {
		turnId: scope.turnId,
		runId: scope.runId,
		sequence: String(sequence),
	},
});
afterEach(() => {
	vi.resetAllMocks();
	vi.useRealTimers();
});

describe("authorized server replay", () => {
	it("drains more than one page in order and advances only past delivered entries", async () => {
		h.read
			.mockResolvedValueOnce(
				Array.from({ length: 200 }, (_, i) => row(i + 1)),
			)
			.mockResolvedValueOnce([row(201)])
			.mockResolvedValueOnce([]);
		const send = vi.fn();
		const replay = createServerChatReplay({
			scope,
			send,
			isClosed: () => false,
		});
		await replay();
		expect(send).toHaveBeenCalledTimes(201);
		expect(h.read.mock.calls[1][0]).toEqual({
			scope,
			after: row(200).cursor,
		});
		await replay();
		expect(h.read.mock.calls[2][0]).toEqual({
			scope,
			after: row(201).cursor,
		});
	});
	it("serializes a Redis wakeup with a poll without delivering duplicate rows", async () => {
		h.read.mockResolvedValueOnce([row(1)]).mockResolvedValueOnce([]);
		const send = vi.fn();
		const replay = createServerChatReplay({
			scope,
			send,
			isClosed: () => false,
		});
		await Promise.all([replay(), replay()]);
		expect(send).toHaveBeenCalledOnce();
		expect(h.read.mock.calls[1][0].after).toEqual(row(1).cursor);
	});
	it("rechecks authorization while a backlog is draining", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
		h.read.mockImplementationOnce(async () => {
			vi.setSystemTime(new Date("2026-10-29T12:00:06Z"));
			return Array.from({ length: 200 }, (_, i) => row(i + 1));
		});
		const authorize = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("Forbidden"));
		const send = vi.fn();
		await expect(
			createServerChatReplay({
				scope,
				send,
				authorize,
				isClosed: () => false,
			})(),
		).rejects.toThrow("Forbidden");
		expect(send).not.toHaveBeenCalled();
	});
	it("checks history-derived integrity after the read and before delivery", async () => {
		const order: string[] = [];
		h.read.mockImplementation(async () => {
			order.push("read");
			return [row(1)];
		});
		const send = vi.fn();
		await expect(
			createServerChatReplay({
				scope,
				send,
				isClosed: () => false,
				validateIntegrity: async () => {
					order.push("integrity");
					throw new Error("Incomplete");
				},
			})(),
		).rejects.toThrow("Incomplete");
		expect(order).toEqual(["read", "integrity"]);
		expect(send).not.toHaveBeenCalled();
	});
	it("retries a transient read without advancing its cursor", async () => {
		h.read
			.mockRejectedValueOnce(new Error("Connection reset"))
			.mockResolvedValueOnce([row(1)]);
		const send = vi.fn();
		const replay = createServerChatReplay({
			scope,
			send,
			isClosed: () => false,
		});
		await expect(replay()).rejects.toThrow("Connection reset");
		await replay();
		expect(send).toHaveBeenCalledOnce();
		expect(h.read.mock.calls[1][0].after).toBeUndefined();
	});
	it("does not deliver a page after observation was cancelled", async () => {
		let closed = false;
		h.read.mockImplementation(async () => {
			closed = true;
			return [row(1)];
		});
		const send = vi.fn();
		await createServerChatReplay({ scope, send, isClosed: () => closed })();
		expect(send).not.toHaveBeenCalled();
	});
	it("checks current authorization again before replay after access revocation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
		h.read.mockResolvedValue([]);
		const authorize = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("Forbidden"));
		const replay = createServerChatReplay({
			scope,
			send: vi.fn(),
			isClosed: () => false,
			authorize,
		});
		await replay();
		vi.setSystemTime(new Date("2026-10-29T12:00:06Z"));
		await expect(replay()).rejects.toThrow("Forbidden");
		expect(h.read).toHaveBeenCalledOnce();
	});
	it("does not swallow an expired-cursor failure or produce a completion", async () => {
		h.read.mockRejectedValue(new Error("Cursor expired"));
		const send = vi.fn();
		await expect(
			createServerChatReplay({
				scope,
				after: row(1).cursor,
				send,
				isClosed: () => false,
			})(),
		).rejects.toThrow("expired");
		expect(send).not.toHaveBeenCalled();
	});

	it("stops on a durable gap marker instead of silently splicing later text", async () => {
		h.read.mockResolvedValue([
			{
				...row(1),
				event: "execution.replay_unavailable",
				data: { message: "Replay output is incomplete" },
			},
			row(2),
		]);
		const send = vi.fn();
		await expect(
			createServerChatReplay({ scope, send, isClosed: () => false })(),
		).rejects.toThrow("incomplete");
		expect(send).not.toHaveBeenCalled();
	});
	it("projects a tool result to a single acknowledged event, including its arguments", () => {
		expect(
			projectChatReplayEvent({
				event: "execution.tool_complete",
				data: {
					toolCall: {
						id: "example-tool",
						name: "search",
						args: { query: "Example" },
						result: "Found",
						status: "success",
					},
				},
			}),
		).toMatchObject({
			type: "tool_result",
			toolCallId: "example-tool",
			args: { query: "Example" },
			result: "Found",
		});
	});
});
