import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@repo/api/modules/projects/lib/parlume-realtime-session", () => ({
	createParlumeRealtimeSession: mocks.create,
}));

import { POST } from "../route";

function ask(
	body: unknown = { sessionId: "session-1", botId: "bot-1" },
	token = "secret",
) {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/realtime-session",
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
	process.env.AGENT_SERVICE_SECRET = "secret";
});

describe("Parlume realtime session", () => {
	it("returns the client secret, its expiry, the model and its host, and nothing else", async () => {
		mocks.create.mockResolvedValue({
			engine: "realtime",
			clientSecret: "ek_minted",
			expiresAt: 1_900_000_000,
			model: "gpt-realtime-2.1",
			realtimeUrl:
				"https://example-resource.openai.azure.com/openai/v1/realtime",
		});
		const response = await POST(ask());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			clientSecret: "ek_minted",
			expiresAt: 1_900_000_000,
			model: "gpt-realtime-2.1",
			realtimeUrl:
				"https://example-resource.openai.azure.com/openai/v1/realtime",
		});
		expect(mocks.create).toHaveBeenCalledWith({
			sessionId: "session-1",
			botId: "bot-1",
		});
	});

	it("tells the bridge to stay classic when realtime is unavailable", async () => {
		mocks.create.mockResolvedValue({ engine: "classic", reason: "no_key" });
		const response = await POST(ask());
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			engine: "classic",
			reason: "no_key",
		});
	});

	it("rejects a caller without the service token", async () => {
		const response = await POST(ask(undefined, "wrong"));
		expect(response.status).toBe(401);
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("rejects a body without a session and bot", async () => {
		const response = await POST(ask({ sessionId: "session-1" }));
		expect(response.status).toBe(400);
		expect(mocks.create).not.toHaveBeenCalled();
	});
});
