import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const record = vi.hoisted(() => vi.fn());
vi.mock("@repo/api/modules/projects/lib/parlume-suggestion-records", () => ({
	recordParlumeSuggestion: record,
}));

import { POST } from "../route";

function request(body: unknown, token = "secret") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/suggestions",
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

const teamOnly = {
	sessionId: "session-1",
	botId: "bot-1",
	kind: "missed_question",
	text: "Who signs off the migration?",
	speaker: "Dana",
	quote: "we cover the data migration",
	topic: "Data migration",
	chatTag: null,
};

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "secret";
	record.mockResolvedValue(true);
});

describe("recording a Parlume suggestion", () => {
	it("rejects a caller without the service token", async () => {
		const response = await POST(request(teamOnly, "wrong"));

		expect(response.status).toBe(401);
		expect(record).not.toHaveBeenCalled();
	});

	it.each([
		["a team-only suggestion", teamOnly],
		[
			"a suggestion posted in the chat",
			{ ...teamOnly, kind: "answer", chatTag: "P8" },
		],
	])("records %s", async (_label, body) => {
		const response = await POST(request(body));

		expect(await response.json()).toEqual({ recorded: true });
		expect(record).toHaveBeenCalledWith(body);
	});

	// The session decides who a suggestion was for; a bridge that still sends
	// an audience is heard, and its audience ignored.
	it("ignores an audience the bridge sends", async () => {
		const response = await POST(
			request({ ...teamOnly, audience: "MEETING" }),
		);

		expect(await response.json()).toEqual({ recorded: true });
		expect(record).toHaveBeenCalledWith(teamOnly);
	});

	it.each([
		["an unknown kind", { ...teamOnly, kind: "recap" }],
		["no quote", { ...teamOnly, quote: " " }],
		["a tag that is not a chat tag", { ...teamOnly, chatTag: "F-12" }],
		["an oversized text", { ...teamOnly, text: "x".repeat(501) }],
	])("refuses %s", async (_label, body) => {
		const response = await POST(request(body));

		expect(response.status).toBe(400);
		expect(record).not.toHaveBeenCalled();
	});

	it("answers 404 for a session that is not live or a bot that is not its own", async () => {
		record.mockResolvedValue(false);

		const response = await POST(request(teamOnly));

		expect(response.status).toBe(404);
	});
});
