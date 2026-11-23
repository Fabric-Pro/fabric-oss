import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks, permissions } = vi.hoisted(() => {
	const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {};
	const permissions: string[] = [];
	const mocks = {
		requireProject: vi.fn(),
		sessionFindFirst: vi.fn(),
		sessionFindUniqueOrThrow: vi.fn(),
		contextFindFirst: vi.fn(),
		purge: vi.fn(),
		drain: vi.fn(),
		canDelete: vi.fn(),
		mayRead: vi.fn(),
		purgeBridge: vi.fn(),
		recordAudit: vi.fn(),
	};
	return { handlers, mocks, permissions };
});

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.sessionFindFirst(...args),
			findUniqueOrThrow: (...args: unknown[]) =>
				mocks.sessionFindUniqueOrThrow(...args),
		},
		projectContext: {
			findFirst: (...args: unknown[]) => mocks.contextFindFirst(...args),
		},
	},
	purgeParlumeSessionContent: (...args: unknown[]) => mocks.purge(...args),
}));

vi.mock("../sessions", () => ({
	requireParlumeProject: (...args: unknown[]) =>
		mocks.requireProject(...args),
}));

vi.mock("../../../lib/parlume-start", () => ({
	sessionSelect: { id: true, transcriptDeletedAt: true },
}));

vi.mock("../../../lib/parlume-log", () => ({
	parlumeLog: () => undefined,
}));

vi.mock("../../../lib/delete-synced-context", () => ({
	drainSyncedContextCleanupOnce: (...args: unknown[]) => mocks.drain(...args),
}));

vi.mock("../../../lib/parlume-transcript-access", () => ({
	canDeleteParlumeSession: (...args: unknown[]) => mocks.canDelete(...args),
}));

vi.mock("../../../lib/parlume-confidential", () => ({
	mayReadParlumeSessionContent: (...args: unknown[]) =>
		mocks.mayRead(...args),
}));

vi.mock("../../../lib/parlume-bridge-purge", () => ({
	requestParlumeBridgePurge: (...args: unknown[]) =>
		mocks.purgeBridge(...args),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => mocks.recordAudit(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (handler: (...args: never[]) => Promise<unknown>) => {
			handlers.deleteSession = handler;
			return { _handler: handler };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_READ: "read" },
		requireProjectPermission: (permission: string) => {
			permissions.push(permission);
			return chainable;
		},
	};
});

await import("../delete-session");

const context = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev" },
	session: {},
};
const input = { projectId: "project-1", sessionId: "session-1" };
const cleanup = {
	id: "cleanup-1",
	projectId: "project-1",
	contextIds: ["context-1"],
};

function deleteSession() {
	return handlers.deleteSession({ input, context });
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.requireProject.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.sessionFindFirst.mockResolvedValue({
		id: "session-1",
		userId: "inviter-1",
		transcriptContextId: "context-1",
		confidential: false,
		attendeeUserIds: [],
	});
	mocks.contextFindFirst.mockResolvedValue({
		metadata: { parlumeNotesStatus: "READY", parlumeNotes: "Decided." },
	});
	mocks.canDelete.mockResolvedValue(true);
	mocks.mayRead.mockResolvedValue(true);
	mocks.purgeBridge.mockResolvedValue(undefined);
	mocks.purge.mockResolvedValue({ purged: true, vectorCleanup: cleanup });
	mocks.drain.mockResolvedValue(undefined);
	mocks.sessionFindUniqueOrThrow.mockResolvedValue({
		id: "session-1",
		transcriptDeletedAt: new Date("2026-10-01T10:00:00Z"),
	});
});

describe("deleteParlumeSessionProcedure", () => {
	it("is open only to readers of the project, so an outsider never reaches it", () => {
		expect(permissions).toEqual(["read"]);
	});

	it("deletes the session's content for the inviter or a manager, empties the bridge, and audits it", async () => {
		const result = await deleteSession();

		expect(mocks.canDelete).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			inviterId: "inviter-1",
		});
		expect(mocks.purge).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			scope: "SESSION",
		});
		expect(mocks.purgeBridge).toHaveBeenCalledExactlyOnceWith(
			"session-1",
			"deleted",
		);
		expect(mocks.drain).toHaveBeenCalledWith(cleanup);
		expect(mocks.recordAudit).toHaveBeenCalledWith(context, {
			action: "project.parlume.session_deleted",
			category: "project",
			organizationId: "org-1",
			projectId: "project-1",
			resource: { type: "parlume_meeting_session", id: "session-1" },
		});
		expect(result).toEqual({
			session: {
				id: "session-1",
				transcriptDeletedAt: new Date("2026-10-01T10:00:00Z"),
			},
		});
	});

	it("does not drain when there was no transcript vector to clean", async () => {
		mocks.purge.mockResolvedValue({ purged: true, vectorCleanup: null });

		await deleteSession();

		expect(mocks.drain).not.toHaveBeenCalled();
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
	});

	it("refuses a project reader, invited to the meeting or not, who did not invite Parlume and does not manage the project", async () => {
		mocks.canDelete.mockResolvedValue(false);

		await expect(deleteSession()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.purge).not.toHaveBeenCalled();
		expect(mocks.purgeBridge).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("refuses an inviter who may not read the confidential meeting they invited Parlume to", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-1",
			userId: "user-1",
			transcriptContextId: "context-1",
			confidential: true,
			attendeeUserIds: ["someone-else"],
		});
		mocks.mayRead.mockResolvedValue(false);

		await expect(deleteSession()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.mayRead).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			session: expect.objectContaining({
				confidential: true,
				attendeeUserIds: ["someone-else"],
			}),
		});
		expect(mocks.purge).not.toHaveBeenCalled();
	});

	it("says the session is not found when it belongs to another project", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);

		await expect(deleteSession()).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "session-1", projectId: "project-1" },
			}),
		);
		expect(mocks.purge).not.toHaveBeenCalled();
	});

	it("refuses while the notes are still being written from the transcript", async () => {
		mocks.contextFindFirst.mockResolvedValue({
			metadata: { parlumeNotesStatus: "PENDING" },
		});

		await expect(deleteSession()).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.contextFindFirst).toHaveBeenCalledWith({
			where: {
				id: "context-1",
				projectId: "project-1",
				organizationId: "org-1",
			},
			select: { metadata: true },
		});
		expect(mocks.purge).not.toHaveBeenCalled();
	});

	it("refuses a session Parlume is still in or still saving, and deletes nothing", async () => {
		mocks.purge.mockResolvedValue({ purged: false, vectorCleanup: null });

		await expect(deleteSession()).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Stop Parlume"),
		});
		expect(mocks.drain).not.toHaveBeenCalled();
		expect(mocks.purgeBridge).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});
});
