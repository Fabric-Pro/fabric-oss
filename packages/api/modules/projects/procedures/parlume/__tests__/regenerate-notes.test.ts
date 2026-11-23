import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks, permissions } = vi.hoisted(() => {
	const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {};
	const permissions: string[] = [];
	const mocks = {
		requireProject: vi.fn(),
		sessionFindFirst: vi.fn(),
		contextFindFirst: vi.fn(),
		contextUpdate: vi.fn(),
		canDelete: vi.fn(),
		mayRead: vi.fn(),
		recordAudit: vi.fn(),
		workflowStart: vi.fn(),
	};
	return { handlers, mocks, permissions };
});

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.sessionFindFirst(...args),
		},
		projectContext: {
			findFirst: (...args: unknown[]) => mocks.contextFindFirst(...args),
			update: (...args: unknown[]) => mocks.contextUpdate(...args),
		},
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: (...args: unknown[]) => mocks.workflowStart(...args),
		},
	}),
}));

vi.mock("../sessions", () => ({
	requireParlumeProject: (...args: unknown[]) =>
		mocks.requireProject(...args),
}));

vi.mock("../../../lib/parlume-log", () => ({
	parlumeLog: () => undefined,
}));

vi.mock("../../../lib/parlume-transcript-access", () => ({
	canDeleteParlumeSession: (...args: unknown[]) => mocks.canDelete(...args),
}));

vi.mock("../../../lib/parlume-confidential", () => ({
	mayReadParlumeSessionContent: (...args: unknown[]) =>
		mocks.mayRead(...args),
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
			handlers.regenerateNotes = handler;
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

await import("../regenerate-notes");

const context = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev" },
	session: {},
};
const input = { projectId: "project-1", sessionId: "session-1" };
const notes = {
	provider: "attendee",
	parlumeNotes: "### Decisions\n- Ship the draft.",
	parlumeNotesStatus: "COMPLETED",
};

function regenerateNotes() {
	return handlers.regenerateNotes({ input, context });
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
		transcriptDeletedAt: null,
		confidential: false,
		attendeeUserIds: [],
	});
	mocks.contextFindFirst.mockResolvedValue({
		id: "context-1",
		metadata: notes,
	});
	mocks.canDelete.mockResolvedValue(true);
	mocks.mayRead.mockResolvedValue(true);
	mocks.contextUpdate.mockResolvedValue({});
	mocks.workflowStart.mockResolvedValue({});
});

describe("regenerateParlumeNotesProcedure", () => {
	it("marks the notes as being written and starts a notes run under its own id", async () => {
		await expect(regenerateNotes()).resolves.toEqual({
			notesStatus: "PENDING",
		});

		expect(permissions).toEqual(["read"]);
		expect(mocks.contextFindFirst).toHaveBeenCalledWith({
			where: {
				id: "context-1",
				projectId: "project-1",
				organizationId: "org-1",
			},
			select: { id: true, metadata: true },
		});
		expect(mocks.contextUpdate).toHaveBeenCalledWith({
			where: { id: "context-1" },
			data: {
				metadata: {
					...notes,
					parlumeNotesStatus: "PENDING",
					parlumeNotesRequestedAt: expect.any(String),
				},
			},
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeNotesWorkflow",
			expect.objectContaining({
				workflowId: "parlume-notes-regenerate-session-1",
				workflowIdConflictPolicy: "USE_EXISTING",
				args: [
					{
						sessionId: "session-1",
						organizationId: "org-1",
						userId: "inviter-1",
						regenerate: true,
					},
				],
			}),
		);
		const [marked] = mocks.contextUpdate.mock.invocationCallOrder;
		const [started] = mocks.workflowStart.mock.invocationCallOrder;
		expect(marked).toBeLessThan(started ?? 0);
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "project.parlume.notes_regenerated",
				projectId: "project-1",
				resource: { type: "parlume_meeting_session", id: "session-1" },
			}),
		);
	});

	it("regenerates failed notes too", async () => {
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			metadata: { parlumeNotesStatus: "FAILED" },
		});
		await expect(regenerateNotes()).resolves.toEqual({
			notesStatus: "PENDING",
		});
		expect(mocks.workflowStart).toHaveBeenCalledOnce();
	});

	it("is refused to a reader who did not invite Parlume and does not manage the project", async () => {
		mocks.canDelete.mockResolvedValue(false);
		await expect(regenerateNotes()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.canDelete).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			inviterId: "inviter-1",
		});
		expect(mocks.contextUpdate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("is refused for a confidential meeting the caller may not read", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-1",
			userId: "user-1",
			transcriptContextId: "context-1",
			transcriptDeletedAt: null,
			confidential: true,
			attendeeUserIds: ["user-2"],
		});
		mocks.mayRead.mockResolvedValue(false);
		await expect(regenerateNotes()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("is refused while the notes are still being written", async () => {
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			metadata: { parlumeNotesStatus: "PENDING" },
		});
		await expect(regenerateNotes()).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.contextUpdate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("is refused once the transcript is deleted", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-1",
			userId: "inviter-1",
			transcriptContextId: "context-1",
			transcriptDeletedAt: new Date("2026-10-01T10:00:00Z"),
			confidential: false,
			attendeeUserIds: [],
		});
		await expect(regenerateNotes()).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.contextFindFirst).not.toHaveBeenCalled();
	});

	it("is not found for a session of another project", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);
		await expect(regenerateNotes()).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "session-1", projectId: "project-1" },
			}),
		);
	});

	it("puts the earlier status back when the run does not start", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("Temporal is down"));
		await expect(regenerateNotes()).rejects.toThrow("Temporal is down");
		expect(mocks.contextUpdate).toHaveBeenLastCalledWith({
			where: { id: "context-1" },
			data: { metadata: notes },
		});
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});
});
