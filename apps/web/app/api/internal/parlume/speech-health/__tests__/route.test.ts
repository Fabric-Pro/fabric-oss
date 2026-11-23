import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
			update: (...args: unknown[]) => mocks.update(...args),
		},
	},
}));

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

vi.mock("../../lib", () => ({
	isParlumeServiceRequestAuthorized: (value: string | null) =>
		value === "service",
}));

import { POST } from "../route";

const NO_TOTALS = {
	replies: 0,
	speakingMs: 0,
	underrunMs: 0,
	waitMs: 0,
	stallResets: 0,
	stops: 0,
	slowStops: 0,
	worstStopMs: 0,
	resumes: 0,
	failedResumes: 0,
	capped: 0,
	fallbacks: 0,
	auraRetries: 0,
	auraRetryFailures: 0,
};

const TOTALS = {
	...NO_TOTALS,
	replies: 4,
	speakingMs: 60_000,
	underrunMs: 900,
	waitMs: 4_600,
	stops: 2,
	slowStops: 1,
	worstStopMs: 1_800,
	resumes: 1,
	auraRetries: 3,
	auraRetryFailures: 1,
};

function request(overrides: Record<string, unknown> = {}, token = "service") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/speech-health",
		{
			method: "POST",
			headers: { "X-Agent-Service-Token": token },
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				totals: TOTALS,
				...overrides,
			}),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findFirst.mockResolvedValue({ id: "session-1", speechHealth: null });
	mocks.update.mockResolvedValue({});
});

describe("Parlume speech health reports", () => {
	it("refuses a call without the service secret, before reading anything", async () => {
		const response = await POST(request({}, "wrong"));

		expect(response.status).toBe(401);
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.log).not.toHaveBeenCalled();
	});

	it("stores the totals on the session row and logs them as parlume.speech_health", async () => {
		const response = await POST(request());

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.findFirst).toHaveBeenCalledWith({
			where: { id: "session-1", providerBotId: "bot-1" },
			select: { id: true, speechHealth: true },
		});
		expect(mocks.update).toHaveBeenCalledWith({
			where: { id: "session-1" },
			data: { speechHealth: TOTALS },
		});
		expect(mocks.log).toHaveBeenCalledWith("info", "speech_health", {
			sessionId: "session-1",
			botId: "bot-1",
			...TOTALS,
		});
	});

	it("logs only what a report added since the last one", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			speechHealth: { ...TOTALS, replies: 3, slowStops: 0, stops: 1 },
		});

		await POST(request());

		expect(mocks.log).toHaveBeenCalledWith("info", "speech_health", {
			sessionId: "session-1",
			botId: "bot-1",
			...NO_TOTALS,
			replies: 1,
			stops: 1,
			slowStops: 1,
			worstStopMs: 1_800,
		});
	});

	it("never lowers a total for a report that arrives late", async () => {
		const later = { ...TOTALS, replies: 6, speakingMs: 90_000 };
		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			speechHealth: later,
		});

		await POST(request());

		expect(mocks.update).toHaveBeenCalledWith({
			where: { id: "session-1" },
			data: { speechHealth: later },
		});
		expect(mocks.log).toHaveBeenCalledWith(
			"info",
			"speech_health",
			expect.objectContaining({ replies: 0, speakingMs: 0 }),
		);
	});

	it("takes a report, and stored totals, from before the covered wait was counted apart", async () => {
		const { waitMs: _waitMs, ...withoutWait } = TOTALS;
		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			speechHealth: { ...withoutWait, replies: 3 },
		});

		const response = await POST(request({ totals: withoutWait }));

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.update).toHaveBeenCalledWith({
			where: { id: "session-1" },
			data: { speechHealth: { ...TOTALS, waitMs: 0 } },
		});
		expect(mocks.log).toHaveBeenCalledWith(
			"info",
			"speech_health",
			expect.objectContaining({ replies: 1, waitMs: 0, underrunMs: 0 }),
		);
	});

	it("refuses a malformed report", async () => {
		const response = await POST(
			request({ totals: { ...TOTALS, stops: -1 } }),
		);

		expect(response.status).toBe(400);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});

	it("answers 404 for a session the bot is not on", async () => {
		mocks.findFirst.mockResolvedValue(null);

		const response = await POST(request());

		expect(response.status).toBe(404);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.log).not.toHaveBeenCalled();
	});
});
