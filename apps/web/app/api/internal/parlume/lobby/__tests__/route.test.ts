import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	notify: vi.fn(),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-notices", () => ({
	notifyParlumeWaitingInLobby: (...args: unknown[]) => mocks.notify(...args),
}));

import { POST } from "../route";

function request(body: unknown, token = "service-secret") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/lobby",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": token,
			},
			body: JSON.stringify(body),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "service-secret";
});

describe("POST /api/internal/parlume/lobby", () => {
	it("asks for the lobby notice of the bridge's session", async () => {
		const response = await POST(request({ sessionId: "session-1" }));

		expect(response.status).toBe(200);
		expect(mocks.notify).toHaveBeenCalledWith({ sessionId: "session-1" });
	});

	it("refuses a caller without the service token", async () => {
		const response = await POST(
			request({ sessionId: "session-1" }, "wrong-secret"),
		);

		expect(response.status).toBe(401);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("refuses a request without a session", async () => {
		const response = await POST(request({}));

		expect(response.status).toBe(400);
		expect(mocks.notify).not.toHaveBeenCalled();
	});
});
