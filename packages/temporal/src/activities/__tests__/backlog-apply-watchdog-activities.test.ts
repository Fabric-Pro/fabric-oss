/**
 * Unit tests for the backlog-apply watchdog activities.
 *
 *  - `findStaleApplyingProposalsActivity` — maps helper rows using latest activity
 *    time, including null `applyStartedAt`, derives the cutoff from minutes / env default.
 *  - `terminateBacklogApplyWorkflowActivity` — terminate + swallow errors.
 *  - `markBacklogProposalTimedOutActivity` — compare-and-set: audit + finalize
 *    only when the watchdog actually won the transition (count === 1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findStaleMock: vi.fn(),
	timeOutMock: vi.fn(),
	finalizeSessionMock: vi.fn(),
	recordAuditMock: vi.fn(),
	getHandleMock: vi.fn(),
	getTemporalClientMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	findStaleApplyingProposals: (...args: unknown[]) =>
		mocks.findStaleMock(...args),
	timeOutStaleApply: (...args: unknown[]) => mocks.timeOutMock(...args),
	finalizeBacklogUpdateSession: (...args: unknown[]) =>
		mocks.finalizeSessionMock(...args),
	recordAudit: (...args: unknown[]) => mocks.recordAuditMock(...args),
}));

vi.mock("../../client", () => ({
	getTemporalClient: (...args: unknown[]) =>
		mocks.getTemporalClientMock(...args),
}));

// Import AFTER mocks.
import {
	findStaleApplyingProposalsActivity,
	markBacklogProposalTimedOutActivity,
	terminateBacklogApplyWorkflowActivity,
} from "../backlog-apply-watchdog-activities";

beforeEach(() => {
	mocks.findStaleMock.mockReset();
	mocks.timeOutMock.mockReset();
	mocks.finalizeSessionMock.mockReset();
	mocks.recordAuditMock.mockReset();
	mocks.getHandleMock.mockReset();
	mocks.getTemporalClientMock.mockReset();
	mocks.finalizeSessionMock.mockResolvedValue(1);
	process.env.FABRIC_BACKLOG_APPLY_STALE_MINUTES = undefined as never;
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("findStaleApplyingProposalsActivity", () => {
	it("maps stale APPROVED rows without a dispatch timestamp and uses latest activity", async () => {
		mocks.findStaleMock.mockResolvedValueOnce([
			{
				id: "p-1",
				projectId: "proj-1",
				organizationId: "o-1",
				applyWorkflowId: "backlog-apply-proj-1-123",
				applyStartedAt: new Date("2026-06-11T00:00:00Z"),
				reviewedAt: new Date("2026-06-11T00:01:00Z"),
				createdAt: new Date("2026-06-10T00:00:00Z"),
			},
			// APPROVED may be stranded before dispatch writes a timestamp.
			{
				id: "p-skip",
				projectId: "proj-2",
				organizationId: null,
				applyWorkflowId: null,
				applyStartedAt: null,
				reviewedAt: null,
				createdAt: new Date("2026-06-10T00:00:00Z"),
			},
		]);

		const { rows } = await findStaleApplyingProposalsActivity({
			staleAfterMinutes: 15,
			batchSize: 50,
		});

		expect(rows).toHaveLength(2);
		expect(rows[1].applyStartedAtMs).toBe(
			new Date("2026-06-10T00:00:00Z").getTime(),
		);
		expect(rows[0]).toEqual({
			proposalId: "p-1",
			projectId: "proj-1",
			organizationId: "o-1",
			workflowId: "backlog-apply-proj-1-123",
			applyStartedAtMs: new Date("2026-06-11T00:01:00Z").getTime(),
		});
	});

	it("derives the cutoff from staleAfterMinutes", async () => {
		const expectedCutoffMs = Date.now() - 15 * 60_000;
		mocks.findStaleMock.mockImplementationOnce((args: unknown) => {
			const cutoff = (args as { cutoff: Date }).cutoff;
			expect(cutoff.getTime()).toBeGreaterThanOrEqual(
				expectedCutoffMs - 5_000,
			);
			expect(cutoff.getTime()).toBeLessThanOrEqual(
				expectedCutoffMs + 5_000,
			);
			return Promise.resolve([]);
		});

		await findStaleApplyingProposalsActivity({
			staleAfterMinutes: 15,
			batchSize: 25,
		});

		expect(mocks.findStaleMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to the 15-minute default when staleAfterMinutes <= 0 and no env override", async () => {
		const expectedCutoffMs = Date.now() - 15 * 60_000;
		mocks.findStaleMock.mockImplementationOnce((args: unknown) => {
			const cutoff = (args as { cutoff: Date }).cutoff;
			expect(cutoff.getTime()).toBeGreaterThanOrEqual(
				expectedCutoffMs - 5_000,
			);
			expect(cutoff.getTime()).toBeLessThanOrEqual(
				expectedCutoffMs + 5_000,
			);
			return Promise.resolve([]);
		});

		await findStaleApplyingProposalsActivity({
			staleAfterMinutes: 0,
			batchSize: 0,
		});

		// batchSize 0 should default to 50.
		expect(mocks.findStaleMock.mock.calls[0][0]).toMatchObject({
			limit: 50,
		});
	});

	it("honours FABRIC_BACKLOG_APPLY_STALE_MINUTES when staleAfterMinutes is 0", async () => {
		process.env.FABRIC_BACKLOG_APPLY_STALE_MINUTES = "30";
		const expectedCutoffMs = Date.now() - 30 * 60_000;
		mocks.findStaleMock.mockImplementationOnce((args: unknown) => {
			const cutoff = (args as { cutoff: Date }).cutoff;
			expect(cutoff.getTime()).toBeGreaterThanOrEqual(
				expectedCutoffMs - 5_000,
			);
			expect(cutoff.getTime()).toBeLessThanOrEqual(
				expectedCutoffMs + 5_000,
			);
			return Promise.resolve([]);
		});

		await findStaleApplyingProposalsActivity({
			staleAfterMinutes: 0,
			batchSize: 10,
		});

		expect(mocks.findStaleMock).toHaveBeenCalledTimes(1);
	});
});

describe("terminateBacklogApplyWorkflowActivity", () => {
	it("terminates the workflow with the supplied reason", async () => {
		const terminateMock = vi.fn().mockResolvedValue(undefined);
		mocks.getHandleMock.mockReturnValue({ terminate: terminateMock });
		mocks.getTemporalClientMock.mockResolvedValueOnce({
			workflow: { getHandle: mocks.getHandleMock },
		});

		await terminateBacklogApplyWorkflowActivity({
			workflowId: "backlog-apply-proj-1-123",
			reason: "backlog_apply_watchdog_stale",
		});

		expect(terminateMock).toHaveBeenCalledWith(
			"backlog_apply_watchdog_stale",
		);
	});

	it("swallows errors from an already-terminal / missing workflow", async () => {
		const terminateMock = vi
			.fn()
			.mockRejectedValue(new Error("workflow not found"));
		mocks.getHandleMock.mockReturnValue({ terminate: terminateMock });
		mocks.getTemporalClientMock.mockResolvedValueOnce({
			workflow: { getHandle: mocks.getHandleMock },
		});

		await expect(
			terminateBacklogApplyWorkflowActivity({
				workflowId: "gone",
				reason: "x",
			}),
		).resolves.toBeUndefined();
	});

	it("is a no-op when the Temporal client cannot be created", async () => {
		mocks.getTemporalClientMock.mockRejectedValueOnce(new Error("offline"));

		await expect(
			terminateBacklogApplyWorkflowActivity({
				workflowId: "wf",
				reason: "y",
			}),
		).resolves.toBeUndefined();
	});
});

describe("markBacklogProposalTimedOutActivity", () => {
	it("flips the row, finalizes the session, writes a timed_out audit when it wins the transition", async () => {
		mocks.timeOutMock.mockResolvedValueOnce(1);

		const killed = await markBacklogProposalTimedOutActivity({
			proposalId: "p-1",
			projectId: "proj-1",
			organizationId: "o-1",
			applyDurationMs: 16 * 60_000,
		});

		expect(killed).toBe(true);
		expect(mocks.timeOutMock).toHaveBeenCalledWith({
			proposalId: "p-1",
			cutoff: expect.any(Date),
			errorClass: "TimedOut",
			errorMessage: expect.stringContaining("timed out"),
		});
		expect(mocks.finalizeSessionMock).toHaveBeenCalledWith({
			pendingProposalId: "p-1",
			status: "FAILED",
		});
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "backlog.proposal.timed_out",
			category: "backlog",
			severity: "warning",
			actor: { type: "system", nameSnapshot: "backlog-apply-watchdog" },
			organizationId: "o-1",
			projectId: "proj-1",
			resource: { type: "backlog_proposal", id: "p-1" },
		});
	});

	it("does nothing (no finalize, no audit) when the row was already terminal (count === 0)", async () => {
		mocks.timeOutMock.mockResolvedValueOnce(0);

		const killed = await markBacklogProposalTimedOutActivity({
			proposalId: "p-raced",
			projectId: "proj-1",
			organizationId: "o-1",
			applyDurationMs: 100,
		});

		expect(killed).toBe(false);
		expect(mocks.finalizeSessionMock).not.toHaveBeenCalled();
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("still resolves when the session finalize rejects (best-effort)", async () => {
		mocks.timeOutMock.mockResolvedValueOnce(1);
		mocks.finalizeSessionMock.mockRejectedValueOnce(new Error("no row"));

		const killed = await markBacklogProposalTimedOutActivity({
			proposalId: "p-1",
			projectId: "proj-1",
			organizationId: null,
			applyDurationMs: 100,
		});

		expect(killed).toBe(true);
		// Audit still written even though the session finalize failed.
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
	});
	it("rechecks the timeout using the same env cutoff as discovery", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
		vi.stubEnv("FABRIC_BACKLOG_APPLY_STALE_MINUTES", "30");
		try {
			mocks.findStaleMock.mockResolvedValue([]);
			mocks.timeOutMock.mockResolvedValue(0);
			await findStaleApplyingProposalsActivity({
				staleAfterMinutes: 0,
				batchSize: 50,
			});
			await markBacklogProposalTimedOutActivity({
				proposalId: "example-proposal",
				projectId: "example-project",
				organizationId: "example-org",
				applyDurationMs: 31 * 60000,
			});
			expect(mocks.timeOutMock.mock.calls[0][0].cutoff).toEqual(
				new Date("2026-10-21T11:30:00Z"),
			);
			expect(mocks.findStaleMock.mock.calls[0][0].cutoff).toEqual(
				new Date("2026-10-21T11:30:00Z"),
			);
		} finally {
			vi.useRealTimers();
			vi.unstubAllEnvs();
		}
	});
});

describe("discovery threshold floor", () => {
	it.each([
		[5, "30", "11:30"],
		[5, "", "11:45"],
		[45, "30", "11:15"],
	])("input %i with env %s scans at %s", async (minutes, env, time) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
		vi.stubEnv("FABRIC_BACKLOG_APPLY_STALE_MINUTES", env);
		try {
			mocks.findStaleMock.mockResolvedValue([]);
			await findStaleApplyingProposalsActivity({
				staleAfterMinutes: minutes,
				batchSize: 50,
			});
			expect(mocks.findStaleMock.mock.calls[0][0].cutoff).toEqual(
				new Date(`2026-10-21T${time}:00Z`),
			);
		} finally {
			vi.useRealTimers();
			vi.unstubAllEnvs();
		}
	});
});
