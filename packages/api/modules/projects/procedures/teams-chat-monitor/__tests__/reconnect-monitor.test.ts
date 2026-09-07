/**
 * Reconnecting a Teams chat monitor to the calling user (Fizzy #2355).
 *
 * The failure this repairs is silent by construction: the monitor runs on one
 * user's delegated token frozen into a Temporal workflow argument, and when that
 * account loses access Graph answers with an empty list rather than an error, so
 * the run still stamps a clean `lastRun`. These tests pin the two halves that
 * make the repair honest — a preflight that changes nothing, and a commit that
 * refuses rather than silently shrinking what the project collects.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		projectFindFirst: vi.fn(),
		chatFindMany: vi.fn(),
		chatUpdateMany: vi.fn(),
		projectUpdate: vi.fn(),
		teamsTool: vi.fn(),
		recordAudit: vi.fn(),
		rebind: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findFirst: mocks.projectFindFirst,
			update: mocks.projectUpdate,
		},
		projectLinkedTeamsChat: {
			findMany: mocks.chatFindMany,
			updateMany: mocks.chatUpdateMany,
		},
	},
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...a: unknown[]) => mocks.teamsTool(...a),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => mocks.recordAudit(...a),
}));

// The Temporal half is exercised by its own suite; here it is a spy so the
// preflight assertions cannot be confused by workflow plumbing.
vi.mock("../../../lib/monitor-reconnect", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../lib/monitor-reconnect")>();
	return {
		...actual,
		rebindMonitorWorkflow: (...a: unknown[]) => mocks.rebind(...a),
	};
});

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.reconnect = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: {
			PROJECT_UPDATE: "project:update",
			PROJECT_SETTINGS_EDIT: "project:settings:edit",
		},
		requireProjectPermission: (permission: string) => {
			handlers.declaredPermission = () => permission;
			return (c: unknown) => c;
		},
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../reconnect-monitor");

const ctx = { user: { id: "new-owner" } };

const call = (preflightOnly: boolean) =>
	(handlers.reconnect as (a: unknown) => Promise<Record<string, unknown>>)({
		input: {
			projectId: "project-1",
			organizationId: "org-1",
			preflightOnly,
		},
		context: ctx,
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindFirst.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
		teamsChatMonitorIntervalMin: 360,
		teamsChatMonitorQuietWindowMin: 60,
		teamsChatMonitorWorkflowId: "old-workflow",
		teamsChatMonitorUserId: "departed-owner",
	});
	mocks.chatFindMany.mockResolvedValue([
		{ id: "row-1", chatId: "chat-a", chatTopic: "Alpha" },
		{ id: "row-2", chatId: "chat-b", chatTopic: "Beta" },
	]);
	mocks.teamsTool.mockResolvedValue({ messages: [] });
	mocks.rebind.mockResolvedValue({
		workflowId: "new-workflow",
		status: "RUNNING",
	});
});

describe("reconnectMonitorProcedure", () => {
	it("is gated looser than unlinking, because it destroys nothing", () => {
		expect((handlers.declaredPermission as () => string)()).toBe(
			"project:update",
		);
	});

	it("asks the monitor's own question, not a nearby one", async () => {
		await call(true);

		// `list_chat_messages_for_monitor` is exactly what the scan calls. The
		// meeting preflight shipped once asking `get_meeting_by_join_url`, which
		// answers only for a meeting's organizer, and reported every meeting as
		// invisible as a result.
		expect(mocks.teamsTool).toHaveBeenCalledWith(
			"list_chat_messages_for_monitor",
			{ chatId: "chat-a", top: 1 },
			"new-owner",
			"org-1",
		);
	});

	it("changes nothing on the preflight path", async () => {
		const result = await call(true);

		expect(result.mode).toBe("preflight");
		expect(result.currentlyBoundTo).toBe("departed-owner");
		expect(mocks.rebind).not.toHaveBeenCalled();
		expect(mocks.projectUpdate).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("excludes paused chats from the question entirely", async () => {
		await call(true);

		expect(mocks.chatFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "project-1", deactivatedAt: null },
			}),
		);
	});

	it("rebinds, persists the new account, and clears the old one's failures", async () => {
		const result = await call(false);

		expect(mocks.rebind).toHaveBeenCalledWith(
			expect.objectContaining({
				previousWorkflowId: "old-workflow",
				cancelSignal: "cancelTeamsChatMonitor",
				workflowType: "teamsChatMonitorWorkflow",
				args: [expect.objectContaining({ userId: "new-owner" })],
			}),
		);
		expect(mocks.projectUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					teamsChatMonitorUserId: "new-owner",
					teamsChatMonitorWorkflowId: "new-workflow",
				}),
			}),
		);
		// Counters describe the account that left; a repaired monitor must not
		// keep showing the banner that sent someone here.
		expect(mocks.chatUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					consecutiveFailures: 0,
					lastErrorMessage: null,
					lastErrorAt: null,
				},
			}),
		);
		expect(result.mode).toBe("reconnected");
		expect(result.currentlyBoundTo).toBe("new-owner");
	});

	it("never rewrites the linked rows' own userId", async () => {
		await call(false);

		const [updateArgs] = mocks.chatUpdateMany.mock.calls[0] as [
			{ data: Record<string, unknown> },
		];
		// That column is the Job Hub's tenancy anchor for telemetry rows, not a
		// credential lookup. Moving it would relabel history for no gain.
		expect(updateArgs.data).not.toHaveProperty("userId");
	});

	it("records who the monitor was taken from", async () => {
		await call(false);

		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.context_source.reconnected",
				metadata: expect.objectContaining({
					previouslyBoundTo: "departed-owner",
					reachableCount: 2,
				}),
			}),
		);
	});

	it("refuses the rebind when the new account can see nothing", async () => {
		mocks.teamsTool.mockResolvedValue({ error: "Forbidden" });

		await expect(call(false)).rejects.toThrow(/visible to your account/);
		expect(mocks.rebind).not.toHaveBeenCalled();
	});

	it("asks for a retry when the provider could not be reached at all", async () => {
		mocks.teamsTool.mockResolvedValue({ error: "429 Too Many Requests" });

		await expect(call(false)).rejects.toThrow(/could not check/);
		expect(mocks.rebind).not.toHaveBeenCalled();
	});

	it("still rebinds when only some chats are unreachable", async () => {
		mocks.teamsTool
			.mockResolvedValueOnce({ messages: [] })
			.mockResolvedValueOnce({ error: "Forbidden" });

		const result = await call(false);

		expect(result.reachableCount).toBe(1);
		expect(result.unreachableLabels).toEqual(["Beta"]);
		expect(mocks.rebind).toHaveBeenCalled();
	});

	it("refuses a project with nothing actively scanned", async () => {
		mocks.chatFindMany.mockResolvedValue([]);

		await expect(call(true)).rejects.toThrow(/no actively scanned chats/);
		expect(mocks.teamsTool).not.toHaveBeenCalled();
	});
});
