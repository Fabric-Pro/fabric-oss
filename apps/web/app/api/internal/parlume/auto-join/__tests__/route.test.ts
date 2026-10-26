import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

const mocks = vi.hoisted(() => ({
	authorized: vi.fn(),
	run: vi.fn(),
}));

vi.mock("../../lib", () => ({
	isParlumeServiceRequestAuthorized: mocks.authorized,
}));
vi.mock("@repo/api/modules/projects/lib/parlume-auto-join", () => ({
	runParlumeAutoJoin: mocks.run,
}));
vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: vi.fn(),
}));

const body = {
	linkedMeetingId: "lm-1",
	occurrenceStart: "2026-10-27T09:00:00.000Z",
};

function request(payload: unknown = body, token = "example-token") {
	return new NextRequest(
		"https://example.com/api/internal/parlume/auto-join",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": token,
			},
			body: JSON.stringify(payload),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.authorized.mockReturnValue(true);
	mocks.run.mockResolvedValue({ outcome: "started", sessionId: "session-1" });
});

describe("Parlume auto-join route", () => {
	it("refuses a caller without the service token", async () => {
		mocks.authorized.mockReturnValue(false);

		const response = await POST(request());

		expect(response.status).toBe(401);
		expect(mocks.authorized).toHaveBeenCalledWith("example-token");
		expect(mocks.run).not.toHaveBeenCalled();
	});

	it("refuses a body without a valid occurrence", async () => {
		const response = await POST(
			request({ linkedMeetingId: "lm-1", occurrenceStart: "tomorrow" }),
		);

		expect(response.status).toBe(400);
		expect(mocks.run).not.toHaveBeenCalled();
	});

	it("joins the occurrence and answers its outcome", async () => {
		const response = await POST(request());

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			outcome: "started",
			sessionId: "session-1",
		});
		expect(mocks.run).toHaveBeenCalledWith({
			linkedMeetingId: "lm-1",
			occurrenceStart: new Date("2026-10-27T09:00:00.000Z"),
		});
	});

	it("answers a refusal with 200, so the scheduler does not retry it", async () => {
		mocks.run.mockResolvedValue({
			outcome: "refused",
			reason: "not_ready",
			message: "Add an Attendee API key in Settings → Meeting assistant.",
		});

		const response = await POST(request());

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			outcome: "refused",
		});
	});

	it("answers an error that is not a decision with 503 for a retry", async () => {
		mocks.run.mockRejectedValue(new Error("database unavailable"));

		const response = await POST(request());

		expect(response.status).toBe(503);
	});
});
