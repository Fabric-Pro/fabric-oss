import { beforeEach, describe, expect, it, vi } from "vitest";

type TranscriptArgs = {
	input: { projectId: string; sessionId: string };
	context: { user: { id: string } };
};
const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	session: vi.fn(),
	segments: vi.fn(),
	canRead: vi.fn(),
	permission: vi.fn(),
	handler: undefined as
		| ((args: TranscriptArgs) => Promise<unknown>)
		| undefined,
}));
vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findFirst: mocks.session },
		parlumeMeetingSegment: { findMany: mocks.segments },
	},
}));
vi.mock("../sessions", () => ({ requireParlumeProject: mocks.project }));
vi.mock("../../../lib/parlume-transcript-access", () => ({
	canReadParlumeTranscript: mocks.canRead,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		handler: (handler: NonNullable<typeof mocks.handler>) => {
			mocks.handler = handler;
			return handler;
		},
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: mocks.permission,
		Permissions: { PROJECT_READ: "project:read" },
	};
});
await import("../transcript");

const session = {
	userId: "inviter",
	inviteeEmails: ["dev@example.com"],
	confidential: false,
	attendeeUserIds: [],
	transcriptDeletedAt: null,
};
const line = (id: string, minute: number) => ({
	id,
	source: "SPEECH",
	speakerName: "Dana",
	text: `Line ${id}`,
	createdAt: new Date(`2026-11-21T10:${String(minute).padStart(2, "0")}:00Z`),
});

const read = (userId = "dev") =>
	mocks.handler?.({
		input: { projectId: "project", sessionId: "session-1" },
		context: { user: { id: userId } },
	});

beforeEach(() => {
	mocks.project
		.mockReset()
		.mockResolvedValue({ id: "project", organizationId: "org" });
	mocks.session.mockReset().mockResolvedValue(session);
	mocks.segments.mockReset().mockResolvedValue([]);
	mocks.canRead.mockReset().mockResolvedValue(true);
});

describe("Parlume live transcript", () => {
	it("gives a reader of the meeting's transcript its newest lines, oldest first", async () => {
		expect(mocks.permission).toHaveBeenCalledWith("project:read");
		// Newest first from the database, as the query asks.
		mocks.segments.mockResolvedValue([line("b", 2), line("a", 1)]);

		await expect(read()).resolves.toEqual({
			readable: true,
			segments: [line("a", 1), line("b", 2)],
		});
		expect(mocks.canRead).toHaveBeenCalledWith({
			projectId: "project",
			userId: "dev",
			inviterId: "inviter",
			inviteeEmails: ["dev@example.com"],
			confidential: false,
			attendeeUserIds: [],
		});
		expect(mocks.segments).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					sessionId: "session-1",
					projectId: "project",
					organizationId: "org",
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 200,
			}),
		);
	});

	it("shows a project reader who was not invited nothing, and reads no lines for them", async () => {
		mocks.canRead.mockResolvedValue(false);

		await expect(read("reader")).resolves.toEqual({
			readable: false,
			segments: [],
		});
		expect(mocks.segments).not.toHaveBeenCalled();
	});

	it("shows nothing once the transcript is deleted", async () => {
		mocks.session.mockResolvedValue({
			...session,
			transcriptDeletedAt: new Date(),
		});

		await expect(read()).resolves.toEqual({
			readable: false,
			segments: [],
		});
		expect(mocks.segments).not.toHaveBeenCalled();
	});

	it("shows nothing for a session of another project", async () => {
		mocks.session.mockResolvedValue(null);

		await expect(read()).resolves.toEqual({
			readable: false,
			segments: [],
		});
		expect(mocks.session).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					projectId: "project",
					organizationId: "org",
				},
			}),
		);
	});
});
