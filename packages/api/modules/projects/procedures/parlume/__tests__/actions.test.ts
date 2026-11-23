import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, permissions, mocks, store } = vi.hoisted(() => {
	const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {};
	const permissions: string[] = [];
	const store: { action: Record<string, unknown> | null } = { action: null };
	const mocks = {
		requireProject: vi.fn(),
		canEdit: vi.fn(),
		recordAudit: vi.fn(),
		workflowStart: vi.fn(),
		mintGrant: vi.fn(),
		userFindUnique: vi.fn(),
		sessionFindUnique: vi.fn(),
		mayRead: vi.fn(),
	};
	return { handlers, permissions, mocks, store };
});

function matches(
	row: Record<string, unknown>,
	where: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(([key, expected]) => {
		const actual = row[key];
		if (
			typeof expected === "object" &&
			expected !== null &&
			!(expected instanceof Date)
		) {
			if ("gt" in expected && expected.gt instanceof Date) {
				return actual instanceof Date && actual > expected.gt;
			}
			if ("lte" in expected && expected.lte instanceof Date) {
				return actual instanceof Date && actual <= expected.lte;
			}
			return false;
		}
		return actual === expected;
	});
}

vi.mock("@repo/database", () => ({
	db: {
		parlumeAction: {
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) =>
					store.action && matches(store.action, where)
						? structuredClone(store.action)
						: null,
			),
			findUniqueOrThrow: vi.fn(async () => structuredClone(store.action)),
			updateMany: vi.fn(
				async ({
					where,
					data,
				}: {
					where: Record<string, unknown>;
					data: Record<string, unknown>;
				}) => {
					if (!store.action || !matches(store.action, where)) {
						return { count: 0 };
					}
					Object.assign(store.action, data);
					return { count: 1 };
				},
			),
		},
		user: { findUnique: mocks.userFindUnique },
		parlumeMeetingSession: { findUnique: mocks.sessionFindUnique },
	},
	canEditProject: mocks.canEdit,
}));
vi.mock("../../../lib/parlume-confidential", () => ({
	mayReadParlumeSessionContent: mocks.mayRead,
}));
vi.mock("@repo/temporal/client", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));
vi.mock("../../../../../lib/agent-service-auth", () => ({
	mintParlumeActingGrantForConfirmedAction: mocks.mintGrant,
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));
vi.mock("../../../lib/parlume-log", () => ({ parlumeLog: vi.fn() }));
vi.mock("../sessions", () => ({
	requireParlumeProject: mocks.requireProject,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const keys = ["get", "confirm", "dismiss"];
	let index = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (handler: (...args: never[]) => Promise<unknown>) => {
			handlers[keys[index++]] = handler;
			return { _handler: handler };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_READ: "read", PROJECT_UPDATE: "update" },
		requireProjectPermission: (permission: string) => {
			permissions.push(permission);
			return chainable;
		},
	};
});

await import("../actions");

type Handler = (input: {
	input: { projectId: string; actionId: string };
	context: { user: { id: string } };
}) => Promise<Record<string, unknown>>;
const call = (name: string, userId = "member") =>
	(handlers[name] as unknown as Handler)({
		input: { projectId: "project", actionId: "action-1" },
		context: { user: { id: userId } },
	});

function proposal(overrides: Record<string, unknown> = {}) {
	return {
		id: "action-1",
		projectId: "project",
		organizationId: "org",
		sessionId: "session",
		toolName: "fabric_create_story",
		summary: "Create feature “Export to CSV”",
		arguments: { title: "Export to CSV", priority: "High" },
		speakerName: "Alex",
		status: "PROPOSED",
		expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		confirmedAt: null,
		startedAt: null,
		completedAt: null,
		decidedByUserId: null,
		chatTag: "P8",
		outcome: null,
		createdAt: new Date(),
		turn: {
			requestText: "create a feature called Export to CSV",
			session: {
				agentLabel: "Fabric Agent",
				status: "ACTIVE",
				createdAt: new Date(),
				joinedAt: new Date(),
			},
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	store.action = proposal();
	mocks.requireProject.mockResolvedValue({
		id: "project",
		organizationId: "org",
	});
	mocks.canEdit.mockResolvedValue(true);
	mocks.workflowStart.mockResolvedValue({});
	mocks.mintGrant.mockReturnValue("member-grant");
	mocks.userFindUnique.mockResolvedValue({ name: "Maya" });
	mocks.sessionFindUnique.mockResolvedValue({
		confidential: false,
		attendeeUserIds: [],
	});
	mocks.mayRead.mockResolvedValue(true);
});

describe("Parlume proposals from a confidential meeting", () => {
	it("are not found for a member who was not in the meeting and does not manage the project", async () => {
		const session = { confidential: true, attendeeUserIds: ["attendee"] };
		mocks.sessionFindUnique.mockResolvedValue(session);
		mocks.mayRead.mockResolvedValue(false);

		await expect(call("get", "absent-reader")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(call("confirm", "absent-reader")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.mayRead).toHaveBeenCalledWith({
			projectId: "project",
			userId: "absent-reader",
			session,
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("Parlume proposal procedures", () => {
	it("reads with project read access and confirms or dismisses only with edit rights", () => {
		expect(permissions).toEqual(["read", "update", "update"]);
	});

	it("shows a proposal with every argument, who asked and whether the viewer may confirm", async () => {
		mocks.canEdit.mockResolvedValue(false);

		const result = await call("get", "reader");

		expect(result).toMatchObject({
			canConfirm: false,
			action: {
				id: "action-1",
				status: "PROPOSED",
				summary: "Create feature “Export to CSV”",
				arguments: { title: "Export to CSV", priority: "High" },
				speakerName: "Alex",
				requestText: "create a feature called Export to CSV",
				session: { agentLabel: "Fabric Agent" },
			},
		});
		expect(mocks.canEdit).toHaveBeenCalledWith("project", "reader");
	});

	it("answers not found for a proposal of another organization or project", async () => {
		store.action = proposal({ organizationId: "other-org" });

		await expect(call("get")).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(call("confirm")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("runs a confirmed change once, as the confirming member, and audits that member", async () => {
		await call("confirm");
		await expect(call("confirm", "second-member")).rejects.toMatchObject({
			code: "CONFLICT",
		});

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeConfirmedActionWorkflow",
			expect.objectContaining({
				workflowId: "parlume-action-action-1",
				args: [{ actionId: "action-1", actingGrant: "member-grant" }],
			}),
		);
		expect(mocks.mintGrant).toHaveBeenCalledWith({
			userId: "member",
			organizationId: "org",
			projectId: "project",
		});
		expect(store.action).toMatchObject({
			status: "EXECUTING",
			decidedByUserId: "member",
			confirmedAt: expect.any(Date),
		});
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			{ user: { id: "member" } },
			expect.objectContaining({
				action: "project.parlume.action_confirmed",
				resource: { type: "parlume_action", id: "action-1" },
			}),
		);
	});

	it("refuses an expired proposal and records it as expired", async () => {
		store.action = proposal({ expiresAt: new Date(Date.now() - 1_000) });

		const read = await call("get");
		await expect(call("confirm")).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("expired"),
		});

		expect(read).toMatchObject({ action: { status: "EXPIRED" } });
		expect(store.action).toMatchObject({ status: "EXPIRED" });
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("reopens the proposal when the change could not be started", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("Temporal down"));

		await expect(call("confirm")).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});

		expect(store.action).toMatchObject({
			status: "PROPOSED",
			decidedByUserId: null,
		});
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("treats a start Temporal says already happened as started, and keeps the change confirmed", async () => {
		const alreadyStarted = new Error("Workflow execution already started");
		alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
		mocks.workflowStart.mockRejectedValue(alreadyStarted);

		await expect(call("confirm")).resolves.toMatchObject({
			action: { status: "EXECUTING" },
		});

		expect(store.action).toMatchObject({
			status: "EXECUTING",
			decidedByUserId: "member",
		});
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		await expect(call("confirm", "second-member")).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it("does not reopen a change whose run claimed it although the start reply was lost", async () => {
		mocks.workflowStart.mockImplementation(async () => {
			if (store.action) {
				store.action.startedAt = new Date();
			}
			throw new Error("Deadline exceeded");
		});

		await expect(call("confirm")).resolves.toMatchObject({
			action: { status: "EXECUTING" },
		});

		expect(store.action).toMatchObject({
			status: "EXECUTING",
			decidedByUserId: "member",
			startedAt: expect.any(Date),
		});
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
	});

	it("dismisses a proposal, audits the member, and then refuses to confirm it", async () => {
		const result = await call("dismiss");
		await expect(call("confirm")).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("dismissed"),
		});

		expect(result).toMatchObject({
			action: { status: "CANCELLED", decidedByName: "Maya" },
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			{ user: { id: "member" } },
			expect.objectContaining({
				action: "project.parlume.action_dismissed",
			}),
		);
	});

	it("refuses to dismiss a proposal that was already confirmed", async () => {
		await call("confirm");

		await expect(call("dismiss")).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("already confirmed"),
		});
	});
});
