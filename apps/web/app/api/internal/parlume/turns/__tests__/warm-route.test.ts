import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindFirst: vi.fn(),
	getTemporalClient: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { parlumeMeetingSession: { findFirst: mocks.sessionFindFirst } },
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));
vi.mock("@repo/api/modules/projects/lib/parlume-attendee", () => ({
	deleteParlumeMeetingBotData: vi.fn(),
	getParlumeBridgeSettings: vi.fn(),
}));

import { GET } from "../route";

function request(query = "?sessionId=session-1", token?: string) {
	return new NextRequest(
		`https://fabric.example/api/internal/parlume/turns${query}`,
		{
			method: "GET",
			headers: token ? { "X-Agent-Service-Token": token } : {},
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	mocks.sessionFindFirst.mockResolvedValue({ id: "session-1" });
	mocks.getTemporalClient.mockResolvedValue({});
});

describe("Parlume turns route warm-up", () => {
	it("opens the database and Temporal connections for an authorized caller", async () => {
		const response = await GET(request(undefined, "service-secret"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ warm: true });
		expect(mocks.getTemporalClient).toHaveBeenCalledTimes(1);
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
			where: { id: "session-1" },
			select: { id: true },
		});
	});

	it("fails closed without the service credential and touches nothing", async () => {
		const response = await GET(request(undefined, "wrong"));

		expect(response.status).toBe(401);
		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
		expect(mocks.sessionFindFirst).not.toHaveBeenCalled();
	});

	it("warms the connections without a session id", async () => {
		const response = await GET(request("", "service-secret"));

		expect(response.status).toBe(200);
		expect(mocks.getTemporalClient).toHaveBeenCalledTimes(1);
		expect(mocks.sessionFindFirst).not.toHaveBeenCalled();
	});

	it("answers even when a connection cannot be opened", async () => {
		mocks.getTemporalClient.mockRejectedValue(new Error("unavailable"));
		mocks.sessionFindFirst.mockRejectedValue(new Error("unavailable"));

		const response = await GET(request(undefined, "service-secret"));

		expect(response.status).toBe(200);
	});
});
