/**
 * Reconnecting a project's meeting sync (Fizzy #2355).
 *
 * The preflight carries the weight here. Microsoft grants transcript access per
 * person, so rebinding to an account with narrower access silently shrinks what
 * the project collects — and it shrinks *silently*, because an unresolvable
 * meeting comes back as an empty result rather than an error. These tests pin
 * that the check runs, that it reports rather than throws, that preflight
 * changes nothing, and that a rebind which would collect nothing is refused
 * outright.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	dbMock,
	executeTeamsToolMock,
	clearFailuresMock,
	startWorkflowMock,
	describeMock,
	getHandleMock,
} = vi.hoisted(() => ({
	dbMock: {
		project: { findFirst: vi.fn(), update: vi.fn() },
		projectLinkedMeeting: { findMany: vi.fn() },
	},
	executeTeamsToolMock: vi.fn(),
	clearFailuresMock: vi.fn(),
	startWorkflowMock: vi.fn(),
	describeMock: vi.fn(),
	getHandleMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: dbMock,
	clearMeetingSyncFailures: clearFailuresMock,
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: executeTeamsToolMock,
}));

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: startWorkflowMock,
			getHandle: getHandleMock,
		},
	}),
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const build = () => {
		const chain: Record<string, unknown> = {};
		for (const k of ["use", "route", "input"]) {
			chain[k] = () => chain;
		}
		chain.handler = (fn: unknown) => fn;
		return chain;
	};
	return {
		tenantProtectedProcedure: build(),
		requireProjectPermission: () => undefined,
		Permissions: { PROJECT_UPDATE: "project:update" },
	};
});

import { repairSyncProcedure } from "../repair-sync";

const handler = repairSyncProcedure as unknown as (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

const CONTEXT = { user: { id: "user_new" }, session: {} };

const MEETINGS = [
	{ id: "lm_1", joinUrl: "https://teams.example/1", subject: "Weekly sync" },
	{
		id: "lm_2",
		joinUrl: "https://teams.example/2",
		subject: "Design review",
	},
	{ id: "lm_3", joinUrl: "https://teams.example/3", subject: "Client call" },
];

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.project.findFirst.mockResolvedValue({
		id: "proj_1",
		organizationId: null,
		meetingTranscriptSyncEnabled: true,
		meetingTranscriptSyncIntervalMin: 60,
		meetingTranscriptSyncWorkflowId: "wf_old",
		meetingTranscriptSyncUserId: "user_gone",
	});
	dbMock.project.update.mockResolvedValue({});
	dbMock.projectLinkedMeeting.findMany.mockResolvedValue(MEETINGS);
	executeTeamsToolMock.mockResolvedValue({ id: "graph_meeting" });
	clearFailuresMock.mockResolvedValue({ count: 0 });
	startWorkflowMock.mockResolvedValue({ workflowId: "wf_new" });
	describeMock.mockResolvedValue({ status: { name: "RUNNING" } });
	getHandleMock.mockReturnValue({
		signal: vi.fn(),
		cancel: vi.fn(),
		describe: describeMock,
	});
});

const PREFLIGHT = {
	projectId: "proj_1",
	organizationId: null,
	preflightOnly: true,
};
const COMMIT = { ...PREFLIGHT, preflightOnly: false };

describe("repairSyncProcedure", () => {
	it("names the meetings the new account cannot see, and changes nothing", async () => {
		// The third meeting resolves to nothing — Microsoft's way of saying
		// "not yours", which is NOT an error.
		executeTeamsToolMock
			.mockResolvedValueOnce({ id: "g1" })
			.mockResolvedValueOnce({ id: "g2" })
			.mockResolvedValueOnce(null);

		const result = await handler({ input: PREFLIGHT, context: CONTEXT });

		expect(result.mode).toBe("preflight");
		expect(result.reachableCount).toBe(2);
		expect(result.unreachableSubjects).toEqual(["Client call"]);
		expect(result.currentlyBoundTo).toBe("user_gone");

		// Preflight is a report. Nothing rebinds, nothing restarts.
		expect(startWorkflowMock).not.toHaveBeenCalled();
		expect(dbMock.project.update).not.toHaveBeenCalled();
	});

	it("treats a throw from Graph as unreachable rather than fatal", async () => {
		executeTeamsToolMock
			.mockResolvedValueOnce({ id: "g1" })
			.mockRejectedValueOnce(new Error("403 Forbidden"))
			.mockResolvedValueOnce({ id: "g3" });

		const result = await handler({ input: PREFLIGHT, context: CONTEXT });

		// One unreachable meeting must not block repairing the rest.
		expect(result.reachableCount).toBe(2);
		expect(result.unreachableSubjects).toEqual(["Design review"]);
	});

	it("rebinds to the caller and confirms the workflow is actually running", async () => {
		const result = await handler({ input: COMMIT, context: CONTEXT });

		expect(result.mode).toBe("repaired");
		expect(result.workflowStatus).toBe("RUNNING");
		expect(startWorkflowMock).toHaveBeenCalledWith(
			"meetingTranscriptSyncWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ userId: "user_new" })],
			}),
		);
		expect(dbMock.project.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					meetingTranscriptSyncUserId: "user_new",
				}),
			}),
		);
		expect(clearFailuresMock).toHaveBeenCalledWith("proj_1");
	});

	it("resolves Graph and rebinds under the project's organization, not the caller's", async () => {
		dbMock.project.findFirst.mockResolvedValue({
			id: "proj_1",
			organizationId: "org_real",
			meetingTranscriptSyncEnabled: true,
			meetingTranscriptSyncIntervalMin: 60,
			meetingTranscriptSyncWorkflowId: "wf_old",
			meetingTranscriptSyncUserId: "user_gone",
		});

		await handler({
			input: { ...COMMIT, organizationId: "org_forged" },
			context: CONTEXT,
		});

		// The organization decides which Microsoft connection the preflight
		// resolves meetings through, so taking it from the input let a caller
		// point the lookup at a tenant they only claimed to be in.
		for (const call of executeTeamsToolMock.mock.calls) {
			expect(call[3]).toBe("org_real");
		}

		// And the rebound workflow carries the same one — a sync bound to the
		// wrong tenant is exactly the silent failure repair exists to fix.
		expect(startWorkflowMock).toHaveBeenCalledWith(
			"meetingTranscriptSyncWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ organizationId: "org_real" })],
			}),
		);
	});

	it("refuses a rebind that would leave the project collecting nothing", async () => {
		executeTeamsToolMock.mockResolvedValue(null);

		await expect(
			handler({ input: COMMIT, context: CONTEXT }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(startWorkflowMock).not.toHaveBeenCalled();
		expect(dbMock.project.update).not.toHaveBeenCalled();
	});

	it("survives a failed cancel of the old workflow", async () => {
		getHandleMock.mockReturnValueOnce({
			signal: vi.fn().mockRejectedValue(new Error("already gone")),
			cancel: vi.fn(),
			describe: describeMock,
		});

		// Two workflows briefly racing costs Graph calls, not data: transcript
		// ingestion is idempotent. Refusing to repair would be worse.
		const result = await handler({ input: COMMIT, context: CONTEXT });
		expect(result.mode).toBe("repaired");
	});

	it("refuses when the project has no actively syncing meetings", async () => {
		dbMock.projectLinkedMeeting.findMany.mockResolvedValue([]);

		await expect(
			handler({ input: PREFLIGHT, context: CONTEXT }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
