import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const suggest = vi.hoisted(() => vi.fn());
vi.mock("@repo/api/modules/projects/lib/parlume-suggestions", () => ({
	suggestParlumeMeetingContribution: suggest,
}));

import { POST } from "../route";

function request(body: unknown, token = "secret") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/suggest",
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
	suggest.mockResolvedValue({
		suggest: true,
		text: "F-12 already covers it.",
	});
});

describe("Parlume suggestion pass", () => {
	it("rejects a caller without the service token", async () => {
		const response = await POST(
			request({ sessionId: "session-1", botId: "bot-1" }, "wrong"),
		);

		expect(response.status).toBe(401);
		expect(suggest).not.toHaveBeenCalled();
	});

	it("answers with the pass's suggestion", async () => {
		const response = await POST(
			request({
				sessionId: "session-1",
				botId: "bot-1",
				previous: ["Earlier idea"],
			}),
		);

		expect(await response.json()).toEqual({
			suggest: true,
			text: "F-12 already covers it.",
		});
		expect(suggest).toHaveBeenCalledWith({
			sessionId: "session-1",
			botId: "bot-1",
			previous: ["Earlier idea"],
		});
	});

	it("refuses an oversized list of earlier suggestions", async () => {
		const response = await POST(
			request({
				sessionId: "session-1",
				botId: "bot-1",
				previous: Array.from({ length: 25 }, () => "idea"),
			}),
		);

		expect(response.status).toBe(400);
		expect(suggest).not.toHaveBeenCalled();
	});
});
