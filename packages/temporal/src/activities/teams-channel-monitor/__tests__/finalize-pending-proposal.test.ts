/**
 * Unit tests for `finalizePendingProposalActivity` — the activity called by
 * `backlogApplyChangesWorkflow` to flip a PendingBacklogProposal into its
 * terminal state once the apply step completes.
 *
 * The contract added in the failure-fallback work:
 *
 *   - The FAILED branch persists a classified `errorClass` (e.g.
 *     "PmAuthError", "PayloadTooLarge", "default") alongside a clean short
 *     `errorMessage` and the raw multi-line `applyError` text. The
 *     downstream inbox + roadmap banner read `errorClass` to map to the
 *     plain-English failure copy.
 *   - The classification at the *workflow* level is computed via
 *     `unwrapPmSyncError(error)`. This activity unit test pins three
 *     representative cases (`PmAuthError`, `PayloadTooLarge`, `default`)
 *     so the round-trip — workflow `unwrapPmSyncError → activity →
 *     markPendingProposalFailed` — is asserted from a single
 *     deterministic seed.
 *   - The dedup-guard idempotency invariant: the activity does NOT delete
 *     or re-create the proposal row. Its proposal id is the same row that
 *     a follow-up retry will flip from FAILED → PENDING, and any title
 *     collision at retry time short-circuits to APPLIED. The mock for
 *     `markPendingProposalFailed` proves the row is updated in place.
 *
 * External boundaries mocked: `@repo/database` only (the query helpers).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { unwrapPmSyncError } from "../../../workflows/pm-sync-error-unwrap";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		markPendingProposalFailed: vi.fn(),
		markPendingProposalApplied: vi.fn(),
		appendAppliedChangeIndexes: vi.fn(),
		finalizeBacklogUpdateSession: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	appendAppliedChangeIndexes: mocks.appendAppliedChangeIndexes,
	finalizeBacklogUpdateSession: mocks.finalizeBacklogUpdateSession,
	getLinkedTeamsChannelsForMonitor: vi.fn(),
	markPendingProposalApplied: mocks.markPendingProposalApplied,
	markPendingProposalFailed: mocks.markPendingProposalFailed,
	recordTeamsChannelFailure: vi.fn(),
	setTeamsChannelScanPageToken: vi.fn(),
	updateTeamsChannelCursor: vi.fn(),
	updateTeamsChannelMonitorLastRun: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { finalizePendingProposalActivity } from "../fetch-channel-cursor";

beforeEach(() => {
	mocks.markPendingProposalFailed.mockReset();
	mocks.markPendingProposalApplied.mockReset();
	mocks.appendAppliedChangeIndexes.mockReset();
	mocks.finalizeBacklogUpdateSession.mockReset();
	mocks.markPendingProposalFailed.mockResolvedValue(undefined);
	mocks.markPendingProposalApplied.mockResolvedValue(undefined);
	mocks.appendAppliedChangeIndexes.mockResolvedValue(undefined);
	mocks.finalizeBacklogUpdateSession.mockResolvedValue(0);
});

describe("finalizePendingProposalActivity — terminal-state writes", () => {
	it("APPLIED outcome — calls markPendingProposalApplied and not markPendingProposalFailed", async () => {
		await finalizePendingProposalActivity({
			proposalId: "p-1",
			outcome: "applied",
			appliedChangeIndexes: [0, 1, 2],
		});
		expect(mocks.markPendingProposalApplied).toHaveBeenCalledWith("p-1");
		expect(mocks.markPendingProposalFailed).not.toHaveBeenCalled();
		expect(mocks.appendAppliedChangeIndexes).toHaveBeenCalledWith(
			"p-1",
			[0, 1, 2],
		);
		// Session-history mirror: applied outcome → APPLIED; appliedCount is left
		// undefined so the query derives "all applied" (a PM-sync miss on an
		// otherwise-clean apply must not render a false "M failed").
		const appliedCall = mocks.finalizeBacklogUpdateSession.mock.calls[0][0];
		expect(appliedCall.pendingProposalId).toBe("p-1");
		expect(appliedCall.status).toBe("APPLIED");
		expect(appliedCall.appliedCount).toBeUndefined();
	});

	it("PARTIALLY_APPLIED — failed outcome with some applied indexes splits the count", async () => {
		await finalizePendingProposalActivity({
			proposalId: "p-partial",
			outcome: "failed",
			appliedChangeIndexes: [0, 1],
			errorMessage: "some failed",
		});
		expect(mocks.finalizeBacklogUpdateSession).toHaveBeenCalledWith(
			expect.objectContaining({
				pendingProposalId: "p-partial",
				status: "PARTIALLY_APPLIED",
				appliedCount: 2,
			}),
		);
	});

	it("APPLIED with PM conflicts → proposal APPLIED, session PARTIALLY_APPLIED (applied minus conflicts)", async () => {
		// A clean Fabric apply where M items hit a PM content conflict: the
		// conflicts are counted in appliedChangeIndexes (idempotency) but are
		// "need review", not "done". The proposal stays APPLIED (not failed, not
		// stuck), while the session surfaces the "2 applied · 3 need review" split
		// plus the Review Center note.
		await finalizePendingProposalActivity({
			proposalId: "p-conflict",
			outcome: "applied",
			appliedChangeIndexes: [0, 1, 2, 3, 4],
			pmConflictCount: 3,
		});
		// Proposal row: APPLIED — a drifted PM push must never fail the proposal.
		expect(mocks.markPendingProposalApplied).toHaveBeenCalledWith(
			"p-conflict",
		);
		expect(mocks.markPendingProposalFailed).not.toHaveBeenCalled();
		// Session: partial, fully-synced applied = 5 - 3 = 2, with the note.
		const call = mocks.finalizeBacklogUpdateSession.mock.calls[0][0];
		expect(call.status).toBe("PARTIALLY_APPLIED");
		expect(call.appliedCount).toBe(2);
		expect(call.errors).toEqual([
			"3 item(s) changed in the PM tool — resolve in the Review Center.",
		]);
	});

	it("APPLIED with zero conflicts stays a clean APPLIED session", async () => {
		// Guard the common path: no conflicts → APPLIED, appliedCount derived.
		await finalizePendingProposalActivity({
			proposalId: "p-clean",
			outcome: "applied",
			appliedChangeIndexes: [0, 1],
			pmConflictCount: 0,
		});
		const call = mocks.finalizeBacklogUpdateSession.mock.calls[0][0];
		expect(call.status).toBe("APPLIED");
		expect(call.appliedCount).toBeUndefined();
	});

	it("FAILED outcome — writes structured errorClass + errorMessage + rawApplyError", async () => {
		await finalizePendingProposalActivity({
			proposalId: "p-2",
			outcome: "failed",
			errorClass: "PmAuthError",
			errorMessage: "Auth refused by ADO",
			rawApplyError:
				"Stack trace: PmAuthError: 401 from upstream… (multi-line raw body)",
		});
		expect(mocks.markPendingProposalFailed).toHaveBeenCalledWith("p-2", {
			errorClass: "PmAuthError",
			errorMessage: "Auth refused by ADO",
			rawApplyError:
				"Stack trace: PmAuthError: 401 from upstream… (multi-line raw body)",
		});
		// Session-history mirror: failed outcome with no applied indexes → FAILED.
		expect(mocks.finalizeBacklogUpdateSession).toHaveBeenCalledWith(
			expect.objectContaining({
				pendingProposalId: "p-2",
				status: "FAILED",
			}),
		);
	});

	it("FAILED outcome with missing classifier — defaults errorClass to 'default'", async () => {
		await finalizePendingProposalActivity({
			proposalId: "p-3",
			outcome: "failed",
			errorMessage: "Generic failure",
		});
		expect(mocks.markPendingProposalFailed).toHaveBeenCalledWith("p-3", {
			errorClass: "default",
			errorMessage: "Generic failure",
			rawApplyError: undefined,
		});
	});

	it("skips appendAppliedChangeIndexes when the list is empty", async () => {
		await finalizePendingProposalActivity({
			proposalId: "p-4",
			outcome: "applied",
			appliedChangeIndexes: [],
		});
		expect(mocks.appendAppliedChangeIndexes).not.toHaveBeenCalled();
		expect(mocks.markPendingProposalApplied).toHaveBeenCalledWith("p-4");
	});
});

describe("unwrapPmSyncError → finalize round-trip (workflow-side classification)", () => {
	it("classifies a PmAuthError throw and persists errorClass='PmAuthError'", async () => {
		const inner = new Error("Auth refused by ADO");
		(inner as Error & { type?: string }).type = "PmAuthError";
		const wrapper = new Error("Workflow execution failed");
		(wrapper as Error & { cause?: unknown }).cause = inner;

		const { errorClass, message } = unwrapPmSyncError(wrapper);
		expect(errorClass).toBe("PmAuthError");
		await finalizePendingProposalActivity({
			proposalId: "p-PmAuthError",
			outcome: "failed",
			errorClass,
			errorMessage: message,
			rawApplyError: wrapper.message,
		});
		expect(mocks.markPendingProposalFailed).toHaveBeenCalledWith(
			"p-PmAuthError",
			expect.objectContaining({ errorClass: "PmAuthError" }),
		);
	});

	it("classifies a PayloadTooLarge throw and persists errorClass='PayloadTooLarge'", async () => {
		const inner = new Error("Body too long for PM tool");
		(inner as Error & { type?: string }).type = "PayloadTooLarge";
		const wrapper = new Error("Activity task failed");
		(wrapper as Error & { cause?: unknown }).cause = inner;

		const { errorClass, message } = unwrapPmSyncError(wrapper);
		expect(errorClass).toBe("PayloadTooLarge");
		await finalizePendingProposalActivity({
			proposalId: "p-PayloadTooLarge",
			outcome: "failed",
			errorClass,
			errorMessage: message,
			rawApplyError: wrapper.message,
		});
		expect(mocks.markPendingProposalFailed).toHaveBeenCalledWith(
			"p-PayloadTooLarge",
			expect.objectContaining({ errorClass: "PayloadTooLarge" }),
		);
	});

	it("falls back to errorClass='Error' (a 'default' bucket) for a plain Error throw", async () => {
		const e = new Error("Something else went wrong");
		const { errorClass, message } = unwrapPmSyncError(e);
		// `unwrapPmSyncError` returns the constructor name when no `type`
		// is set — for a plain `Error` that is "Error", which the inbox
		// renderer treats as the unknown / default bucket via the copy
		// helper's fallback.
		expect(errorClass).toBe("Error");
		await finalizePendingProposalActivity({
			proposalId: "p-default",
			outcome: "failed",
			errorClass,
			errorMessage: message,
			rawApplyError: e.message,
		});
		expect(mocks.markPendingProposalFailed).toHaveBeenCalledWith(
			"p-default",
			expect.objectContaining({ errorClass: "Error" }),
		);
	});
});
