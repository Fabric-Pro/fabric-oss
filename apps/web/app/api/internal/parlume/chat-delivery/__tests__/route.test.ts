import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindFirst: vi.fn(),
	turnFindFirst: vi.fn(),
	turnUpdate: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findFirst: mocks.sessionFindFirst },
		parlumeMeetingTurn: {
			findFirst: mocks.turnFindFirst,
			update: mocks.turnUpdate,
		},
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
				latencyMs: 8_200,
				...overrides,
			}),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "secret";
	mocks.sessionFindFirst.mockResolvedValue({ id: "session-1" });
	mocks.turnFindFirst.mockResolvedValue({ id: "turn-1", error: null });
	mocks.turnUpdate.mockResolvedValue(undefined);
});

describe("Parlume chat delivery reports", () => {
	it("rejects a caller without the service token", async () => {
		const response = await POST(report({}, "wrong"));

		expect(response.status).toBe(401);
		expect(mocks.sessionFindFirst).not.toHaveBeenCalled();
	});

	it("notes a post that never appeared on its request", async () => {
		const response = await POST(report());

		expect(response.status).toBe(200);
		expect(mocks.turnFindFirst).toHaveBeenCalledWith({
			where: { id: "turn-1", sessionId: "session-1" },
			select: { id: true, error: true },
		});
		expect(mocks.turnUpdate).toHaveBeenCalledWith({
			where: { id: "turn-1" },
			data: {
				error: "Chat message P3 was sent but did not appear in the meeting chat within 8 seconds.",
			},
		});
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"chat.delivery",
			expect.objectContaining({ tag: "P3", outcome: "unconfirmed" }),
		);
	});

	it("adds to a note the request already has", async () => {
		mocks.turnFindFirst.mockResolvedValue({
			id: "turn-1",
			error: "Spoken reply unavailable.",
		});

		await POST(report({ outcome: "unavailable" }));

		expect(mocks.turnUpdate).toHaveBeenCalledWith({
			where: { id: "turn-1" },
			data: {
				error: "Spoken reply unavailable. Chat message P3 did not appear: this meeting's chat looks unavailable to Parlume.",
			},
		});
	});

	it("leaves a promptly confirmed post unnoted", async () => {
		await POST(report({ outcome: "confirmed", latencyMs: 1_200 }));

		expect(mocks.turnFindFirst).not.toHaveBeenCalled();
		expect(mocks.turnUpdate).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(
			"info",
			"chat.delivery",
			expect.objectContaining({ outcome: "confirmed" }),
		);
	});

	it("notes a confirmation that came after the post was reported missing", async () => {
		await POST(report({ outcome: "confirmed", latencyMs: 12_400 }));

		expect(mocks.turnUpdate).toHaveBeenCalledWith({
			where: { id: "turn-1" },
			data: {
				error: "Chat message P3 appeared in the meeting chat after 12 s.",
			},
		});
	});

	it("logs a suggestion, which belongs to no request", async () => {
		const response = await POST(
			report({ turnId: null, kind: "suggestion" }),
		);

		expect(response.status).toBe(200);
		expect(mocks.turnUpdate).not.toHaveBeenCalled();
	});

	it("notes a held change's post that never appeared on its request", async () => {
		const response = await POST(report({ kind: "held" }));

		expect(response.status).toBe(200);
		expect(mocks.turnUpdate).toHaveBeenCalledOnce();
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"chat.delivery",
			expect.objectContaining({ kind: "held" }),
		);
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
