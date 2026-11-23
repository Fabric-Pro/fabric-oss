import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindFirst: vi.fn(),
	turnFindFirst: vi.fn(),
	turnUpdate: vi.fn(),
	suggestionUpdateMany: vi.fn(),
	actionUpdateMany: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findFirst: mocks.sessionFindFirst },
		parlumeMeetingTurn: {
			findFirst: mocks.turnFindFirst,
			update: mocks.turnUpdate,
		},
		parlumeSuggestion: { updateMany: mocks.suggestionUpdateMany },
		parlumeAction: { updateMany: mocks.actionUpdateMany },
	},
}));

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

import { POST } from "../route";

function report(overrides: Record<string, unknown> = {}, token = "secret") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/chat-delivery",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": token,
			},
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				turnId: "turn-1",
				tag: "P3",
				kind: "reply",
				outcome: "unconfirmed",
				latencyMs: 15_200,
				...overrides,
			}),
		},
	);
}

function turn(overrides: Record<string, unknown> = {}) {
	return {
		id: "turn-1",
		error: null,
		chatTags: [],
		chatUnshownTags: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "secret";
	mocks.sessionFindFirst.mockResolvedValue({ id: "session-1" });
	mocks.turnFindFirst.mockResolvedValue(turn());
	mocks.turnUpdate.mockResolvedValue(undefined);
	mocks.suggestionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.actionUpdateMany.mockResolvedValue({ count: 1 });
});

describe("Parlume chat delivery reports", () => {
	it("rejects a caller without the service token", async () => {
		const response = await POST(report({}, "wrong"));

		expect(response.status).toBe(401);
		expect(mocks.sessionFindFirst).not.toHaveBeenCalled();
	});

	it("notes a post that never appeared on its request, and keeps its tag as not shown", async () => {
		const response = await POST(report());

		expect(response.status).toBe(200);
		expect(mocks.turnFindFirst).toHaveBeenCalledWith({
			where: { id: "turn-1", sessionId: "session-1" },
			select: {
				id: true,
				error: true,
				chatTags: true,
				chatUnshownTags: true,
			},
		});
		expect(mocks.turnUpdate).toHaveBeenCalledWith({
			where: { id: "turn-1" },
			data: {
				error: "Chat message P3 was sent but did not appear in the meeting chat within 15 seconds.",
				chatTags: [],
				chatUnshownTags: ["P3"],
			},
		});
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"chat.delivery",
			expect.objectContaining({ tag: "P3", outcome: "unconfirmed" }),
		);
	});

	it("adds to a note the request already has", async () => {
		mocks.turnFindFirst.mockResolvedValue(
			turn({ error: "Spoken reply unavailable.", chatTags: ["P2"] }),
		);

		await POST(report({ outcome: "unavailable" }));

		expect(mocks.turnUpdate).toHaveBeenCalledWith({
			where: { id: "turn-1" },
			data: {
				error: "Spoken reply unavailable. Chat message P3 did not appear: this meeting's chat looks unavailable to Parlume.",
				chatTags: ["P2"],
				chatUnshownTags: ["P3"],
			},
		});
	});

	it("stores the tag of a promptly confirmed post as shown, with no note", async () => {
		await POST(report({ outcome: "confirmed", latencyMs: 1_200 }));

		expect(mocks.turnUpdate).toHaveBeenCalledWith({
			where: { id: "turn-1" },
			data: { chatTags: ["P3"], chatUnshownTags: [] },
		});
		expect(mocks.log).toHaveBeenCalledWith(
			"info",
			"chat.delivery",
			expect.objectContaining({ outcome: "confirmed" }),
		);
	});

	it("notes a confirmation that came after the post was reported missing", async () => {
		await POST(report({ outcome: "confirmed", latencyMs: 18_400 }));

		expect(mocks.turnUpdate).toHaveBeenCalledWith({
			where: { id: "turn-1" },
			data: {
				error: "Chat message P3 appeared in the meeting chat after 18 s.",
				chatTags: ["P3"],
				chatUnshownTags: [],
			},
		});
	});

	it("replaces the missing-post note, and the not-shown tag, when the post appears after all", async () => {
		mocks.turnFindFirst.mockResolvedValue(
			turn({
				error: "Spoken reply unavailable. Chat message P3 was sent but did not appear in the meeting chat within 15 seconds.",
				chatUnshownTags: ["P3"],
			}),
		);

		await POST(report({ outcome: "confirmed", latencyMs: 16_300 }));

		expect(mocks.turnUpdate).toHaveBeenCalledWith({
			where: { id: "turn-1" },
			data: {
				error: "Spoken reply unavailable. Chat message P3 appeared in the meeting chat after 16 s.",
				chatTags: ["P3"],
				chatUnshownTags: [],
			},
		});
	});

	it("stores on a suggestion whether the chat showed its post, and on no request", async () => {
		const response = await POST(
			report({ turnId: null, kind: "suggestion" }),
		);

		expect(response.status).toBe(200);
		expect(mocks.turnUpdate).not.toHaveBeenCalled();
		expect(mocks.suggestionUpdateMany).toHaveBeenCalledWith({
			where: { sessionId: "session-1", chatTag: "P3" },
			data: { chatDelivery: "NOT_SHOWN" },
		});

		await POST(
			report({
				turnId: null,
				kind: "suggestion",
				outcome: "confirmed",
				latencyMs: 4_000,
			}),
		);
		expect(mocks.suggestionUpdateMany).toHaveBeenLastCalledWith({
			where: { sessionId: "session-1", chatTag: "P3" },
			data: { chatDelivery: "SHOWN" },
		});
	});

	it("stores the recap's delivery: a reply that belongs to no request", async () => {
		await POST(
			report({ turnId: null, outcome: "confirmed", latencyMs: 3_000 }),
		);

		expect(mocks.turnFindFirst).not.toHaveBeenCalled();
		expect(mocks.suggestionUpdateMany).toHaveBeenCalledWith({
			where: { sessionId: "session-1", chatTag: "P3", kind: "RECAP" },
			data: { chatDelivery: "SHOWN" },
		});
	});

	it("notes a proposal's missing post on its request, and stores the delivery on the change", async () => {
		const response = await POST(report({ kind: "proposal" }));

		expect(response.status).toBe(200);
		expect(mocks.turnUpdate).toHaveBeenCalledOnce();
		expect(mocks.turnUpdate).toHaveBeenCalledWith({
			where: { id: "turn-1" },
			data: {
				error: "Chat message P3 was sent but did not appear in the meeting chat within 15 seconds.",
			},
		});
		expect(mocks.actionUpdateMany).toHaveBeenCalledWith({
			where: { sessionId: "session-1", chatTag: "P3" },
			data: { chatDelivery: "NOT_SHOWN" },
		});
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"chat.delivery",
			expect.objectContaining({ kind: "proposal" }),
		);
	});

	it("records the delivery of a tagged notice, which belongs to no row", async () => {
		const response = await POST(report({ turnId: null, kind: "notice" }));

		expect(response.status).toBe(200);
		expect(mocks.turnUpdate).not.toHaveBeenCalled();
		expect(mocks.suggestionUpdateMany).not.toHaveBeenCalled();
		expect(mocks.actionUpdateMany).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"chat.delivery",
			expect.objectContaining({ kind: "notice", tag: "P3" }),
		);
	});

	it("refuses a report for the held post kind, which no longer exists", async () => {
		const response = await POST(report({ kind: "held" }));

		expect(response.status).toBe(400);
	});

	it("refuses a report for another session's bot", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);

		const response = await POST(report());

		expect(response.status).toBe(404);
		expect(mocks.turnUpdate).not.toHaveBeenCalled();
	});

	it.each([
		["a malformed tag", { tag: "[P3]" }],
		["an unknown outcome", { outcome: "delivered" }],
		["a negative latency", { latencyMs: -1 }],
	])("refuses %s", async (_label, overrides) => {
		const response = await POST(report(overrides));

		expect(response.status).toBe(400);
	});
});
