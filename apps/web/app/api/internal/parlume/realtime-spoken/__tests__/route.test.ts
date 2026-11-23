import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindFirst: vi.fn(),
	turnUpdateMany: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findFirst: mocks.sessionFindFirst },
		parlumeMeetingTurn: { updateMany: mocks.turnUpdateMany },
	},
}));

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

import { POST } from "../route";

const FIRST_AUDIO_AT = Date.UTC(2030, 0, 1, 10, 0, 0);
const SPOKEN_AT = FIRST_AUDIO_AT + 4_200;

function report(overrides: Record<string, unknown> = {}, token = "secret") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/realtime-spoken",
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
				firstAudioAt: FIRST_AUDIO_AT,
				spokenAt: SPOKEN_AT,
				interrupted: false,
				...overrides,
			}),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "secret";
	mocks.sessionFindFirst.mockResolvedValue({ id: "session-1" });
	mocks.turnUpdateMany.mockResolvedValue({ count: 1 });
});

describe("Parlume realtime voice playback reports", () => {
	it("rejects a caller without the service token", async () => {
		const response = await POST(report({}, "wrong"));

		expect(response.status).toBe(401);
		expect(mocks.sessionFindFirst).not.toHaveBeenCalled();
	});

	it("records when a job's answer was first heard and finished on its turn", async () => {
		const response = await POST(report());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ recorded: true });
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
			where: { id: "session-1", providerBotId: "bot-1" },
			select: { id: true },
		});
		expect(mocks.turnUpdateMany).toHaveBeenCalledWith({
			where: { id: "turn-1", sessionId: "session-1" },
			data: {
				firstAudioAt: new Date(FIRST_AUDIO_AT),
				spokenAt: new Date(SPOKEN_AT),
				interruptedAt: null,
			},
		});
	});

	it("records an answer cut short as interrupted, not spoken", async () => {
		await POST(report({ spokenAt: null, interrupted: true }));

		expect(mocks.turnUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					firstAudioAt: new Date(FIRST_AUDIO_AT),
					spokenAt: null,
					interruptedAt: expect.any(Date),
				},
			}),
		);
	});

	it("refuses an unknown session and a malformed report", async () => {
		mocks.sessionFindFirst.mockResolvedValueOnce(null);
		expect((await POST(report())).status).toBe(404);
		expect((await POST(report({ firstAudioAt: "soon" }))).status).toBe(400);
		expect(mocks.turnUpdateMany).not.toHaveBeenCalled();
	});
});
