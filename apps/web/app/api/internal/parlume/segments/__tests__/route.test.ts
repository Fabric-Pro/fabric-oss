import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	createMany: vi.fn(),
	setRange: vi.fn(),
	postNotice: vi.fn(),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-confidential", () => ({
	confidentialRangeSelect: { id: true, confidentialSince: true },
	setParlumeConfidentialRange: (...args: unknown[]) =>
		mocks.setRange(...args),
	postParlumeConfidentialNotice: (...args: unknown[]) =>
		mocks.postNotice(...args),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
		},
		parlumeMeetingSegment: {
			createMany: (...args: unknown[]) => mocks.createMany(...args),
		},
	},
}));

vi.mock("../../lib", () => ({
	isParlumeServiceRequestAuthorized: () => true,
	MAX_PARLUME_SEGMENT_CHARS: 20_000,
	segmentDedupeKey: () => "segment-1",
	chatMessageDedupeKey: (sessionId: string, id: string) =>
		`chat-${sessionId}-${id}`,
}));

import { POST } from "../route";

function request(overrides: Record<string, unknown> = {}) {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/segments",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				text: "Buffered final segment",
				speakerName: null,
				speakerId: null,
				utteranceStartMs: null,
				utteranceEndMs: null,
				...overrides,
			}),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findFirst.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		captureStoppedAt: null,
		confidentialSince: null,
		externalInvitees: false,
		guestJoinedAt: null,
	});
	mocks.createMany.mockResolvedValue({ count: 1 });
	mocks.setRange.mockResolvedValue({ changed: true, open: true });
	mocks.postNotice.mockResolvedValue(true);
});

describe("Parlume confidential part", () => {
	function stored() {
		return mocks.createMany.mock.calls[0]?.[0].data;
	}

	it("stores what is said as ordinary discussion while no confidential part runs", async () => {
		await POST(request());

		expect(stored()).toMatchObject({ confidential: false });
		expect(mocks.setRange).not.toHaveBeenCalled();
	});

	it("stores what is said as confidential while the part runs", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			captureStoppedAt: null,
			confidentialSince: new Date("2026-11-20T10:00:00Z"),
			externalInvitees: false,
			guestJoinedAt: null,
		});

		await POST(request());

		expect(stored()).toMatchObject({ confidential: true });
	});

	it("starts the part from a typed command, stores the command inside it, and tells the chat", async () => {
		await POST(
			request({
				text: "Parlume, off the record",
				speakerName: "Dev One",
				source: "CHAT",
				chatMessageId: "msg_1",
			}),
		);

		expect(stored()).toMatchObject({ confidential: true });
		expect(mocks.setRange).toHaveBeenCalledWith(
			expect.objectContaining({ switch: "on", by: "Dev One" }),
		);
		expect(mocks.postNotice).toHaveBeenCalledWith({
			sessionId: "session-1",
			switch: "on",
			by: "Dev One",
		});
	});

	it("acts on a command delivered again only once", async () => {
		mocks.createMany.mockResolvedValue({ count: 0 });

		await POST(
			request({
				text: "Parlume, end confidential",
				source: "CHAT",
				chatMessageId: "msg_1",
			}),
		);

		expect(mocks.setRange).not.toHaveBeenCalled();
		expect(mocks.postNotice).not.toHaveBeenCalled();
	});

	it("tells the chat nothing when the mark did not change", async () => {
		mocks.setRange.mockResolvedValue({ changed: false, open: true });

		await POST(request({ text: "Hey Parlume, end confidential." }));

		expect(mocks.setRange).toHaveBeenCalledWith(
			expect.objectContaining({ switch: "off" }),
		);
		expect(mocks.postNotice).not.toHaveBeenCalled();
	});

	it("ignores a remark that something is confidential", async () => {
		await POST(request({ text: "The pricing is confidential." }));

		expect(stored()).toMatchObject({ confidential: false });
		expect(mocks.setRange).not.toHaveBeenCalled();
	});
});

describe("Parlume segment drain", () => {
	it("accepts a buffered final segment after the bot failure is recorded", async () => {
		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: {
						in: ["ACTIVE", "LEAVING", "STOP_FAILED", "FAILED"],
					},
				}),
			}),
		);
		expect(mocks.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					text: "Buffered final segment",
				}),
			}),
		);
	});

	it("rejects a late segment after the failed session has been finalized", async () => {
		mocks.findFirst.mockResolvedValue(null);

		const response = await POST(request());

		expect(response.status).toBe(409);
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ finalizedAt: null }),
			}),
		);
		expect(mocks.createMany).not.toHaveBeenCalled();
	});

	it("stores speech by default", async () => {
		await POST(request());

		expect(mocks.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					source: "SPEECH",
					dedupeKey: "segment-1",
				}),
			}),
		);
	});

	it("stores a chat message once per message id", async () => {
		await POST(
			request({
				text: "Here is the plan",
				speakerName: "Dev One",
				source: "CHAT",
				chatMessageId: "msg_1",
			}),
		);

		expect(mocks.createMany).toHaveBeenCalledWith({
			data: expect.objectContaining({
				source: "CHAT",
				dedupeKey: "chat-session-1-msg_1",
				text: "Here is the plan",
				speakerName: "Dev One",
			}),
			skipDuplicates: true,
		});
	});

	it("refuses an unknown segment source", async () => {
		const response = await POST(request({ source: "EMAIL" }));

		expect(response.status).toBe(400);
		expect(mocks.createMany).not.toHaveBeenCalled();
	});
});
