import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks, permissions } = vi.hoisted(() => {
	const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {};
	const permissions: string[] = [];
	const mocks = {
		requireProject: vi.fn(),
		sessionFindFirst: vi.fn(),
		contextFindFirst: vi.fn(),
		organizationFindUnique: vi.fn(),
		proposalFindFirst: vi.fn(),
		createProposal: vi.fn(),
		canRead: vi.fn(),
		recordAudit: vi.fn(),
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
		},
		organization: {
			findUnique: (...args: unknown[]) =>
				mocks.organizationFindUnique(...args),
		},
		pendingBacklogProposal: {
			findFirst: (...args: unknown[]) => mocks.proposalFindFirst(...args),
		},
	},
	computeTodoItemKey: (text: string) => `key(${text})`,
	createPendingBacklogProposal: (...args: unknown[]) =>
		mocks.createProposal(...args),
}));

vi.mock("../sessions", () => ({
	requireParlumeProject: (...args: unknown[]) =>
		mocks.requireProject(...args),
}));

vi.mock("../../../lib/parlume-log", () => ({
	parlumeLog: () => undefined,
}));

vi.mock("../../../lib/parlume-transcript-access", () => ({
	canReadParlumeTranscript: (...args: unknown[]) => mocks.canRead(...args),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => mocks.recordAudit(...args),
}));

vi.mock("../../../../../orpc/middleware/require-permission", () => ({
	userHasProjectPermission: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (handler: (...args: never[]) => Promise<unknown>) => {
			handlers.proposeActionItem = handler;
			return { _handler: handler };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { STORY_CREATE: "story:create" },
		requireProjectPermission: (permission: string) => {
			permissions.push(permission);
			return chainable;
		},
	};
});

await import("../propose-action-item");

const context = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev" },
	session: {},
};
const input = {
	projectId: "project-1",
	sessionId: "session-1",
	anchorLine: 4,
	text: "Send the export to the client.",
};
const action = {
	kind: "action",
	text: "Send the export to the client.",
	anchorLine: 4,
	tentativeOwnerName: "Dana",
	dueHint: "Friday",
};
const session = {
	id: "session-1",
	userId: "inviter-1",
	inviteeEmails: ["dev@example.com"],
	confidential: false,
	attendeeUserIds: [],
	transcriptContextId: "context-1",
	transcriptDeletedAt: null,
	endedAt: new Date("2026-10-01T10:00:00Z"),
	createdAt: new Date("2026-10-01T09:00:00Z"),
	linkedMeeting: null,
};

function proposeActionItem(overrides: Partial<typeof input> = {}) {
	return handlers.proposeActionItem({
		input: { ...input, ...overrides },
		context,
	});
}

function createdWith() {
	const [params] = mocks.createProposal.mock.calls[0] ?? [];
	return params;
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.requireProject.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.sessionFindFirst.mockResolvedValue(session);
	mocks.contextFindFirst.mockResolvedValue({
		id: "context-1",
		content: "Captured incoming speech:\nThe whole meeting.",
		metadata: {
			parlumeNotesStatus: "COMPLETED",
			parlumeNotesItems: {
				version: 1,
				items: [
					{ kind: "decision", text: "Ship it.", anchorLine: 2 },
					action,
				],
			},
		},
	});
	mocks.organizationFindUnique.mockResolvedValue({ slug: "example-org" });
	mocks.proposalFindFirst.mockResolvedValue(null);
	mocks.createProposal.mockResolvedValue({ id: "proposal-1" });
	mocks.canRead.mockResolvedValue(true);
});

describe("proposeParlumeActionItemProcedure", () => {
	it("files the action item into the Proposal Inbox with its owner, due date and transcript line", async () => {
		await expect(proposeActionItem()).resolves.toEqual({
			status: "proposed",
			proposalId: "proposal-1",
		});

		expect(permissions).toEqual(["story:create"]);
		expect(mocks.canRead).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			inviterId: "inviter-1",
			inviteeEmails: ["dev@example.com"],
			confidential: false,
			attendeeUserIds: [],
		});
		expect(mocks.contextFindFirst).toHaveBeenCalledWith({
			where: {
				id: "context-1",
				projectId: "project-1",
				organizationId: "org-1",
			},
			select: { id: true, metadata: true },
		});
		const link =
			"/app/example-org/projects/project-1/contexts/context-1#t-4";
		expect(createdWith()).toMatchObject({
			projectId: "project-1",
			source: "MONITORED_MEETING",
			changeCount: 1,
			userId: "user-1",
			organizationId: "org-1",
			proposal: {
				changes: [
					{
						type: "feature",
						action: "create",
						title: { to: "Send the export to the client." },
					},
				],
			},
			sourceMetadata: {
				parlumeSessionId: "session-1",
				anchorLine: 4,
				transcriptHref: link,
				tentativeOwnerName: "Dana",
				dueHint: "Friday",
			},
		});
		const [change] = createdWith().proposal.changes;
		expect(change.description.to).toContain("Owner: Dana");
		expect(change.description.to).toContain("Due: Friday");
		expect(change.description.to).toContain(`(${link})`);
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "project.parlume.action_item_proposed",
				projectId: "project-1",
				resource: { type: "parlume_meeting_session", id: "session-1" },
				metadata: { proposalId: "proposal-1", anchorLine: 4 },
			}),
		);
	});

	it("copies neither the transcript nor a quote of it into the proposal", async () => {
		await proposeActionItem();

		const { sourceMetadata, proposal } = createdWith();
		expect(sourceMetadata).not.toHaveProperty("transcript");
		expect(sourceMetadata).not.toHaveProperty("quote");
		const stored = JSON.stringify({ sourceMetadata, proposal });
		expect(stored).not.toContain("The whole meeting.");
		expect(stored).not.toContain("Captured incoming speech");
	});

	it("is refused to a member who may not read the meeting's transcript", async () => {
		mocks.canRead.mockResolvedValue(false);

		await expect(proposeActionItem()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.createProposal).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("is refused for a confidential meeting, even to one of its readers", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			...session,
			confidential: true,
			attendeeUserIds: ["user-1"],
		});

		await expect(proposeActionItem()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.createProposal).not.toHaveBeenCalled();
	});

	it("is not found for an item the notes no longer hold, or a note that is not an action item", async () => {
		await expect(
			proposeActionItem({ text: "Something else." }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			proposeActionItem({ anchorLine: 2, text: "Ship it." }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.createProposal).not.toHaveBeenCalled();
	});

	it("is refused once the transcript is deleted", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			...session,
			transcriptDeletedAt: new Date("2026-10-02T10:00:00Z"),
		});

		await expect(proposeActionItem()).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.contextFindFirst).not.toHaveBeenCalled();
	});

	it("is not found for a session of another project", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);

		await expect(proposeActionItem()).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "session-1", projectId: "project-1" },
			}),
		);
	});

	it("returns the open proposal instead of filing the item twice", async () => {
		mocks.proposalFindFirst.mockResolvedValue({ id: "proposal-0" });

		await expect(proposeActionItem()).resolves.toEqual({
			status: "already-proposed",
			proposalId: "proposal-0",
		});
		expect(mocks.proposalFindFirst).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				status: "PENDING",
				sourceMetadata: {
					path: ["parlumeActionItemKey"],
					equals: "session-1:4:key(Send the export to the client.)",
				},
			},
			select: { id: true },
		});
		expect(mocks.createProposal).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});
});
