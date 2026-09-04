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
	// The calendar the SYNC reads, answering with every linked meeting.
	executeTeamsToolMock.mockResolvedValue({
		meetings: MEETINGS.map((m) => ({ joinUrl: m.joinUrl })),
	});
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
		// The third is simply absent from this account's calendar — Microsoft's
		// way of saying "not yours", which is NOT an error.
		executeTeamsToolMock.mockResolvedValue({
			meetings: [
				{ joinUrl: MEETINGS[0].joinUrl },
				{ joinUrl: MEETINGS[1].joinUrl },
			],
		});

		const result = await handler({ input: PREFLIGHT, context: CONTEXT });

		expect(result.mode).toBe("preflight");
		expect(result.reachableCount).toBe(2);
		expect(result.unreachableSubjects).toEqual(["Client call"]);
		expect(result.currentlyBoundTo).toBe("user_gone");

		// Preflight is a report. Nothing rebinds, nothing restarts.
		expect(startWorkflowMock).not.toHaveBeenCalled();
		expect(dbMock.project.update).not.toHaveBeenCalled();
	});

	it("says it could not check rather than reporting everything invisible", async () => {
		executeTeamsToolMock.mockRejectedValue(
			new Error("503 Service Unavailable"),
		);

		// "We could not read your calendar" and "you can see none of these"
		// are opposite recommendations. The old preflight collapsed the first
		// into the second and told people not to repair a healthy project.
		await expect(
			handler({ input: PREFLIGHT, context: CONTEXT }),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});

	it("surfaces a calendar the tool refused to read", async () => {
		executeTeamsToolMock.mockResolvedValue({
			error: "Microsoft not connected. Please connect your Microsoft account.",
		});

		await expect(
			handler({ input: PREFLIGHT, context: CONTEXT }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("asks Microsoft the same question the sync asks", async () => {
		// The bug this pins: the preflight used `get_meeting_by_join_url`,
		// which is `/me/onlineMeetings?$filter=JoinWebUrl eq ...` and returns a
		// row ONLY for the meeting's organizer — so every meeting someone else
		// ran came back empty and was reported invisible. It also passed
		// `joinUrl` where that tool reads `joinWebUrl`, so it threw before it
		// could even be wrong. Mocking the tool hides both: the only defence is
		// asserting the call itself.
		await handler({ input: PREFLIGHT, context: CONTEXT });

		expect(executeTeamsToolMock).toHaveBeenCalledTimes(1);
		const [tool, args] = executeTeamsToolMock.mock.calls[0];
		expect(tool).toBe("list_calendar_meetings");
		// `startDate` is the key the handler reads; a different name silently
		// falls back to its own default window.
		expect(args).toEqual(
			expect.objectContaining({ startDate: expect.any(String) }),
		);
	});

	it("matches join URLs case-insensitively, as the sync does", async () => {
		executeTeamsToolMock.mockResolvedValue({
			meetings: MEETINGS.map((m) => ({
				joinUrl: m.joinUrl.toUpperCase(),
			})),
		});

		const result = await handler({ input: PREFLIGHT, context: CONTEXT });

		expect(result.unreachableSubjects).toEqual([]);
		expect(result.reachableCount).toBe(MEETINGS.length);
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
		executeTeamsToolMock.mockResolvedValue({ meetings: [] });

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
