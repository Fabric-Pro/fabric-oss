import { beforeEach, describe, expect, it, vi } from "vitest";

const { captured, mocks } = vi.hoisted(() => ({
	captured: {
		handler: null as null | ((...args: never[]) => Promise<unknown>),
		permissions: [] as string[],
	},
	mocks: {
		requireParlumeProject: vi.fn(),
		isFeatureEnabled: vi.fn(),
		findFirst: vi.fn(),
		update: vi.fn(),
		connection: vi.fn(),
		readiness: vi.fn(),
		recordAudit: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		projectLinkedMeeting: {
			findFirst: mocks.findFirst,
			update: mocks.update,
		},
	},
	isFeatureEnabled: mocks.isFeatureEnabled,
	resolveWorkflowIntegrationForProvider: mocks.connection,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (handler: (...args: never[]) => Promise<unknown>) => {
			captured.handler = handler;
			return { _handler: handler };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_MEMBERS_MANAGE: "project:members:manage" },
		requireProjectPermission: (permission: string) => {
			captured.permissions.push(permission);
			return chainable;
		},
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? undefined,
	};
});

vi.mock("../../parlume/sessions", () => ({
	requireParlumeProject: mocks.requireParlumeProject,
}));

vi.mock("../../../lib/parlume-readiness", () => ({
	getParlumeReadiness: mocks.readiness,
	isParlumeReady: (readiness: { ready: boolean }) => readiness.ready,
}));

vi.mock("../../../lib/parlume-auto-join", () => ({
	parlumeReadinessRefusal: () =>
		"Parlume has no meeting bot configured. Add an Attendee API key in Settings → Meeting assistant.",
}));

const { PARLUME_AUTO_JOIN_MICROSOFT_REQUIRED, PARLUME_AUTO_JOIN_SYNC_STOPPED } =
	await import("../set-parlume-auto-join");

const context = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev" },
	session: { activeOrganizationId: "org-1" },
};
const input = {
	projectId: "project-1",
	organizationId: "org-1",
	linkedMeetingId: "lm-1",
	enabled: true,
	toolsReadOnly: false,
	suggestionsEnabled: false,
};

function run(overrides: Partial<typeof input> = {}) {
	const handler = captured.handler as unknown as (args: {
		input: typeof input;
		context: typeof context;
	}) => Promise<unknown>;
	return handler({ input: { ...input, ...overrides }, context });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.requireParlumeProject.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.findFirst.mockResolvedValue({ id: "lm-1", subject: "Weekly sync" });
	mocks.connection.mockResolvedValue({ id: "conn-1", credentials: "sealed" });
	mocks.readiness.mockResolvedValue({ ready: true });
	mocks.update.mockImplementation(async ({ data }) => ({
		parlumeAutoJoin: data.parlumeAutoJoin,
		parlumeAutoJoinToolsReadOnly: data.parlumeAutoJoinToolsReadOnly ?? true,
		parlumeAutoJoinSuggestions: data.parlumeAutoJoinSuggestions ?? true,
	}));
});

describe("setParlumeAutoJoin", () => {
	it("needs the permission inviting Parlume needs", () => {
		expect(captured.permissions).toEqual(["project:members:manage"]);
	});

	it("records the caller as the enabler, with the chosen mode and suggestions, and clears the last error", async () => {
		await expect(run()).resolves.toEqual({
			linkedMeetingId: "lm-1",
			enabled: true,
			toolsReadOnly: false,
			suggestionsEnabled: false,
		});
		expect(mocks.update).toHaveBeenCalledWith({
			where: { id: "lm-1" },
			data: {
				parlumeAutoJoin: true,
				parlumeAutoJoinUserId: "user-1",
				parlumeAutoJoinToolsReadOnly: false,
				parlumeAutoJoinSuggestions: false,
				parlumeAutoJoinError: null,
				parlumeAutoJoinErrorAt: null,
			},
			select: expect.any(Object),
		});
	});

	it("checks the Microsoft connection the scheduler will read with", async () => {
		await run();

		expect(mocks.connection).toHaveBeenCalledWith(
			"MICROSOFT_GRAPH",
			"user-1",
			"org-1",
		);
	});

	it("uses the project's organization, never the one the caller names", async () => {
		await run({ organizationId: "org-other" });

		expect(mocks.connection).toHaveBeenCalledWith(
			"MICROSOFT_GRAPH",
			"user-1",
			"org-1",
		);
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({ organizationId: "org-1" }),
		);
	});

	it("refuses to turn on without a Microsoft connection", async () => {
		mocks.connection.mockResolvedValue(null);

		await expect(run()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: PARLUME_AUTO_JOIN_MICROSOFT_REQUIRED,
		});
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("refuses to turn on while Parlume is not ready, naming the setting", async () => {
		mocks.readiness.mockResolvedValue({ ready: false });

		await expect(run()).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Settings → Meeting assistant"),
		});
		expect(mocks.readiness).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("turns off without needing a connection or readiness", async () => {
		mocks.connection.mockResolvedValue(null);
		mocks.readiness.mockResolvedValue({ ready: false });

		await run({ enabled: false });

		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					parlumeAutoJoin: false,
					parlumeAutoJoinUserId: null,
					parlumeAutoJoinError: null,
					parlumeAutoJoinErrorAt: null,
				},
			}),
		);
	});

	it("audits the change on the series", async () => {
		await run();

		expect(mocks.recordAudit).toHaveBeenCalledWith(context, {
			action: "project.parlume.auto_join_changed",
			category: "project",
			organizationId: "org-1",
			projectId: "project-1",
			resource: {
				type: "linked_meeting",
				id: "lm-1",
				name: "Weekly sync",
			},
			metadata: {
				enabled: true,
				toolsReadOnly: false,
				suggestionsEnabled: false,
			},
		});
	});

	it("does not reach a series of another project", async () => {
		mocks.findFirst.mockResolvedValue(null);

		await expect(run()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.findFirst).toHaveBeenCalledWith({
			where: { id: "lm-1", projectId: "project-1" },
			select: { id: true, subject: true, deactivatedAt: true },
		});
	});

	it("refuses to turn on for a series whose syncing is stopped, which the scheduler skips", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "lm-1",
			subject: "Weekly sync",
			deactivatedAt: new Date("2026-10-01T00:00:00Z"),
		});

		await expect(run()).rejects.toMatchObject({
			code: "CONFLICT",
			message: PARLUME_AUTO_JOIN_SYNC_STOPPED,
		});
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("turns off a series whose syncing is stopped", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "lm-1",
			subject: "Weekly sync",
			deactivatedAt: new Date("2026-10-01T00:00:00Z"),
		});

		await run({ enabled: false });

		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ parlumeAutoJoin: false }),
			}),
		);
	});

	it("is unavailable while meeting agendas are off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(run()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.update).not.toHaveBeenCalled();
	});
});
