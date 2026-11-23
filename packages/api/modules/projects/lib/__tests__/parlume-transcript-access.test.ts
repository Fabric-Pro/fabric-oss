import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindFirst: vi.fn(),
	sessionFindMany: vi.fn(),
	userFindUnique: vi.fn(),
	hasPermission: vi.fn(),
	confidentialReader: vi.fn(),
	withheldConfidential: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.sessionFindFirst(...args),
			findMany: (...args: unknown[]) => mocks.sessionFindMany(...args),
		},
		user: {
			findUnique: (...args: unknown[]) => mocks.userFindUnique(...args),
		},
	},
}));

vi.mock("../parlume-confidential", () => ({
	isParlumeConfidentialReader: (...args: unknown[]) =>
		mocks.confidentialReader(...args),
	withheldConfidentialParlumeSessions: (...args: unknown[]) =>
		mocks.withheldConfidential(...args),
}));

vi.mock("../../../../orpc/procedures", () => ({
	Permissions: { PROJECT_MEMBERS_MANAGE: "members:manage" },
	userHasProjectPermission: (...args: unknown[]) =>
		mocks.hasPermission(...args),
}));

const {
	canDeleteParlumeSession,
	canReadParlumeTranscript,
	PARLUME_TRANSCRIPT_WITHHELD,
	parlumeTranscriptNotice,
	resolveParlumeTranscriptAccess,
	withheldParlumeTranscriptIds,
	withoutWithheldParlumeTranscripts,
} = await import("../parlume-transcript-access");

beforeEach(() => {
	vi.resetAllMocks();
	mocks.hasPermission.mockResolvedValue(false);
	mocks.sessionFindMany.mockResolvedValue([]);
	mocks.userFindUnique.mockResolvedValue(null);
	mocks.confidentialReader.mockResolvedValue(true);
	mocks.withheldConfidential.mockResolvedValue({
		sessionIds: new Set(),
		contextIds: new Set(),
	});
});

describe("a confidential meeting's transcript", () => {
	it("is kept from an invitee who was not in the meeting, without asking anything else", async () => {
		mocks.confidentialReader.mockResolvedValue(false);

		await expect(
			canReadParlumeTranscript({
				projectId: "project-1",
				userId: "invitee-1",
				inviterId: "inviter-1",
				inviteeEmails: ["dev.two@example.com"],
				confidential: true,
				attendeeUserIds: ["attendee-1"],
			}),
		).resolves.toBe(false);
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});

	it("is read by a verified attendee who may read the transcript at all", async () => {
		await expect(
			canReadParlumeTranscript({
				projectId: "project-1",
				userId: "inviter-1",
				inviterId: "inviter-1",
				inviteeEmails: [],
				confidential: true,
				attendeeUserIds: ["inviter-1"],
			}),
		).resolves.toBe(true);
	});

	it("is withheld in lists from a reader who was not in the meeting, even one who invited Parlume", async () => {
		mocks.withheldConfidential.mockResolvedValue({
			sessionIds: new Set(["session-1"]),
			contextIds: new Set(["confidential-transcript"]),
		});

		await expect(
			withheldParlumeTranscriptIds({
				projectId: "project-1",
				userId: "inviter-1",
			}),
		).resolves.toEqual(new Set(["confidential-transcript"]));
	});
});

describe("canReadParlumeTranscript", () => {
	it("lets the person who invited Parlume read it without asking for a permission", async () => {
		await expect(
			canReadParlumeTranscript({
				projectId: "project-1",
				userId: "inviter-1",
				inviterId: "inviter-1",
				inviteeEmails: [],
				confidential: false,
				attendeeUserIds: [],
			}),
		).resolves.toBe(true);
		expect(mocks.hasPermission).not.toHaveBeenCalled();
	});

	it("lets a project manager read it", async () => {
		mocks.hasPermission.mockResolvedValue(true);

		await expect(
			canReadParlumeTranscript({
				projectId: "project-1",
				userId: "manager-1",
				inviterId: "inviter-1",
				inviteeEmails: [],
				confidential: false,
				attendeeUserIds: [],
			}),
		).resolves.toBe(true);
		expect(mocks.hasPermission).toHaveBeenCalledWith({
			userId: "manager-1",
			projectId: "project-1",
			permission: "members:manage",
		});
	});

	it("keeps it from another project reader, without looking up their address when nobody was invited", async () => {
		await expect(
			canReadParlumeTranscript({
				projectId: "project-1",
				userId: "reader-1",
				inviterId: "inviter-1",
				inviteeEmails: [],
				confidential: false,
				attendeeUserIds: [],
			}),
		).resolves.toBe(false);
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});

	it("lets a member the meeting's invitation named read it, whatever the case of their address", async () => {
		mocks.userFindUnique.mockResolvedValue({
			email: "Dev.Two@Example.com",
		});

		await expect(
			canReadParlumeTranscript({
				projectId: "project-1",
				userId: "invitee-1",
				inviterId: "inviter-1",
				inviteeEmails: ["dev.two@example.com"],
				confidential: false,
				attendeeUserIds: [],
			}),
		).resolves.toBe(true);
		expect(mocks.userFindUnique).toHaveBeenCalledWith({
			where: { id: "invitee-1" },
			select: { email: true },
		});
	});

	it("keeps it from a project reader the invitation did not name", async () => {
		mocks.userFindUnique.mockResolvedValue({
			email: "dev.three@example.com",
		});

		await expect(
			canReadParlumeTranscript({
				projectId: "project-1",
				userId: "reader-1",
				inviterId: "inviter-1",
				inviteeEmails: ["dev.two@example.com"],
				confidential: false,
				attendeeUserIds: [],
			}),
		).resolves.toBe(false);
	});
});

describe("canDeleteParlumeSession", () => {
	it("lets the inviter and a manager delete, and no invitee", async () => {
		const input = { projectId: "project-1", inviterId: "inviter-1" };

		await expect(
			canDeleteParlumeSession({ ...input, userId: "inviter-1" }),
		).resolves.toBe(true);
		await expect(
			canDeleteParlumeSession({ ...input, userId: "invitee-1" }),
		).resolves.toBe(false);
		mocks.hasPermission.mockResolvedValue(true);
		await expect(
			canDeleteParlumeSession({ ...input, userId: "manager-1" }),
		).resolves.toBe(true);
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});
});

describe("resolveParlumeTranscriptAccess", () => {
	const input = {
		projectId: "project-1",
		userId: "reader-1",
		contextId: "context-1",
	};

	it("is null for a context that is not a Parlume transcript", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);

		await expect(resolveParlumeTranscriptAccess(input)).resolves.toBeNull();
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
			where: { projectId: "project-1", transcriptContextId: "context-1" },
			select: {
				userId: true,
				inviteeEmails: true,
				transcriptDeletedAt: true,
				confidential: true,
				attendeeUserIds: true,
			},
		});
	});

	it("withholds a confidential meeting's transcript from its inviter when they were not in it", async () => {
		mocks.confidentialReader.mockResolvedValue(false);
		mocks.sessionFindFirst.mockResolvedValue({
			userId: "reader-1",
			inviteeEmails: [],
			transcriptDeletedAt: null,
			confidential: true,
			attendeeUserIds: ["attendee-1"],
		});

		await expect(resolveParlumeTranscriptAccess(input)).resolves.toBe(
			"withheld",
		);
		expect(mocks.confidentialReader).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				userId: "reader-1",
				attendeeUserIds: ["attendee-1"],
			}),
		);
	});

	it("withholds a transcript from a reader who was not its inviter, not invited and is not a manager", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			userId: "inviter-1",
			inviteeEmails: [],
			transcriptDeletedAt: null,
		});

		await expect(resolveParlumeTranscriptAccess(input)).resolves.toBe(
			"withheld",
		);
	});

	it("shows the inviter their transcript", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			userId: "reader-1",
			inviteeEmails: [],
			transcriptDeletedAt: null,
		});

		await expect(resolveParlumeTranscriptAccess(input)).resolves.toBe(
			"readable",
		);
	});

	it("shows a member the meeting's invitation named its transcript", async () => {
		mocks.userFindUnique.mockResolvedValue({
			email: "dev.two@example.com",
		});
		mocks.sessionFindFirst.mockResolvedValue({
			userId: "inviter-1",
			inviteeEmails: ["dev.two@example.com"],
			transcriptDeletedAt: null,
		});

		await expect(resolveParlumeTranscriptAccess(input)).resolves.toBe(
			"readable",
		);
	});

	it("says a transcript was deleted, whoever asks", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			userId: "reader-1",
			inviteeEmails: [],
			transcriptDeletedAt: new Date("2026-10-01T10:00:00Z"),
		});

		await expect(resolveParlumeTranscriptAccess(input)).resolves.toBe(
			"deleted",
		);
	});
});

describe("parlumeTranscriptNotice", () => {
	it("says nothing when the transcript is shown", () => {
		expect(parlumeTranscriptNotice(null)).toBeNull();
		expect(parlumeTranscriptNotice("readable")).toBeNull();
	});

	it("says who may read a withheld transcript, and that a deleted one is gone", () => {
		expect(parlumeTranscriptNotice("withheld")).toBe(
			PARLUME_TRANSCRIPT_WITHHELD,
		);
		expect(parlumeTranscriptNotice("deleted")).toContain("was deleted");
	});
});

describe("withheldParlumeTranscriptIds", () => {
	it("names the transcripts of meetings someone else invited Parlume to", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			{ transcriptContextId: "other-transcript" },
		]);

		await expect(
			withheldParlumeTranscriptIds({
				projectId: "project-1",
				userId: "reader-1",
			}),
		).resolves.toEqual(new Set(["other-transcript"]));
		expect(mocks.sessionFindMany).toHaveBeenCalledTimes(1);
		expect(mocks.hasPermission).toHaveBeenCalledTimes(1);
	});

	it("withholds nothing from the inviter, whose own sessions are not asked for", async () => {
		await expect(
			withheldParlumeTranscriptIds({
				projectId: "project-1",
				userId: "inviter-1",
			}),
		).resolves.toEqual(new Set());
		expect(mocks.sessionFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				transcriptContextId: { not: null },
				userId: { not: "inviter-1" },
			},
			select: { transcriptContextId: true },
		});
		expect(mocks.hasPermission).not.toHaveBeenCalled();
	});

	it("does not ask for the sessions whose invitation named the reader", async () => {
		mocks.userFindUnique.mockResolvedValue({
			email: "Dev.Two@example.com",
		});

		await withheldParlumeTranscriptIds({
			projectId: "project-1",
			userId: "invitee-1",
		});

		expect(mocks.sessionFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				transcriptContextId: { not: null },
				userId: { not: "invitee-1" },
				NOT: { inviteeEmails: { has: "dev.two@example.com" } },
			},
			select: { transcriptContextId: true },
		});
	});

	it("withholds nothing from a project manager", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			{ transcriptContextId: "other-transcript" },
		]);
		mocks.hasPermission.mockResolvedValue(true);

		await expect(
			withheldParlumeTranscriptIds({
				projectId: "project-1",
				userId: "manager-1",
			}),
		).resolves.toEqual(new Set());
	});
});

describe("withoutWithheldParlumeTranscripts", () => {
	const contexts = [
		{ id: "document-1" },
		{ id: "own-transcript" },
		{ id: "other-transcript" },
	];

	it("leaves out the transcripts of meetings someone else invited Parlume to", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			{ transcriptContextId: "other-transcript" },
		]);

		await expect(
			withoutWithheldParlumeTranscripts(contexts, {
				projectId: "project-1",
				userId: "reader-1",
			}),
		).resolves.toEqual([{ id: "document-1" }, { id: "own-transcript" }]);
		expect(mocks.sessionFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				transcriptContextId: { not: null },
				userId: { not: "reader-1" },
			},
			select: { transcriptContextId: true },
		});
	});

	it("keeps every transcript for a project manager", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			{ transcriptContextId: "other-transcript" },
		]);
		mocks.hasPermission.mockResolvedValue(true);

		await expect(
			withoutWithheldParlumeTranscripts(contexts, {
				projectId: "project-1",
				userId: "manager-1",
			}),
		).resolves.toEqual(contexts);
	});
});
