/**
 * Tests for the analyzer's structure-preserving update pass
 * (`structurePreserveUpdates`), which rewrites resolved UPDATE proposals so the
 * proposed body preserves the existing item's structure.
 *
 * Verifies: merged result replaces description.to with from=true existing body;
 * safe-hold neutralizes the body diff and stamps bodyMergeFallback; unresolved /
 * non-update / title-only changes are skipped; feature AC handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		reanalyzeBodyByKind: vi.fn(),
		findMany: vi.fn(),
		heartbeat: vi.fn(),
		warn: vi.fn(),
		current: vi.fn(() => {
			throw new Error("outside activity");
		}),
	},
}));

vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { userStory: { findMany: mocks.findMany } },
	normalizeBacklogTitle: (s: string) => s,
	recordAudit: vi.fn(),
	tenantWhere: vi.fn(),
	updateStory: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: mocks.heartbeat,
	Context: { current: mocks.current },
}));
vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: vi.fn(),
}));
vi.mock("../src/lib/reanalyze-body-by-kind", () => ({
	reanalyzeBodyByKind: mocks.reanalyzeBodyByKind,
}));
vi.mock("../src/lib/resolve-backlog-update-target", () => ({
	resolveBacklogUpdateTarget: vi.fn(),
}));
vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: vi.fn(),
}));

import {
	type ChangeProposal,
	createMergeDeadlineScope,
	structurePreserveUpdates,
} from "../src/activities/backlog-context/analyze-context";

function updateChange(over: Record<string, unknown> = {}) {
	return {
		type: "bug",
		action: "update",
		existingId: "story-1",
		title: { from: "Login fails", to: "Login fails" },
		description: {
			from: "stale snapshot",
			to: "analyzer regenerated body",
		},
		reasoning: "root cause confirmed",
		sourceContext: "meeting_transcript",
		...over,
	} as never;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findMany.mockResolvedValue([
		{
			id: "story-1",
			kind: "BUG",
			title: "Login fails",
			identifier: "F-101",
			description:
				"## Steps to Reproduce\n1. x\n## Original Description from User (Do Not Modify)\nbroken",
			acceptanceCriteria: "",
		},
	]);
});

describe("structurePreserveUpdates", () => {
	it("replaces description.to with the merged body and from=true existing body", async () => {
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description:
				"## Steps to Reproduce\n1. x\n## Root Cause\nnull ref\n## Original Description from User (Do Not Modify)\nbroken",
			acceptanceCriteria: undefined,
			fallbackUsed: false,
		});
		const changes = [updateChange()];
		await structurePreserveUpdates({
			changes,
			projectId: "p1",
			userId: "u1",
		});
		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledTimes(1);
		// from is the TRUE existing DB body, to is the merged result
		expect(
			(
				changes[0] as never as {
					description: { from: string; to: string };
				}
			).description.from,
		).toContain("Original Description");
		expect(
			(changes[0] as never as { description: { to: string } }).description
				.to,
		).toContain("null ref");
		expect(
			(changes[0] as never as { bodyMergeFallback?: boolean })
				.bodyMergeFallback,
		).toBeFalsy();
	});

	it("safe-holds: neutralizes the body diff and stamps bodyMergeFallback", async () => {
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description:
				"## Steps to Reproduce\n1. x\n## Original Description from User (Do Not Modify)\nbroken",
			acceptanceCriteria: undefined,
			fallbackUsed: true,
			fallbackReason: "destructive",
		});
		const changes = [updateChange()];
		await structurePreserveUpdates({
			changes,
			projectId: "p1",
			userId: "u1",
		});
		const c = changes[0] as never as {
			description: { from: string; to: string };
			bodyMergeFallback?: boolean;
		};
		// to === from => apply will skip the description write (safe-hold)
		expect(c.description.to).toBe(c.description.from);
		expect(c.bodyMergeFallback).toBe(true);
	});

	it("skips create changes and title-only updates (no reanalyze call)", async () => {
		const changes = [
			updateChange({ action: "create", existingId: null }),
			updateChange({
				description: undefined,
				acceptanceCriteria: undefined,
			}),
		];
		await structurePreserveUpdates({
			changes,
			projectId: "p1",
			userId: "u1",
		});
		expect(mocks.reanalyzeBodyByKind).not.toHaveBeenCalled();
	});

	it("leaves a change untouched when its target row is not found in DB", async () => {
		mocks.findMany.mockResolvedValue([]); // nothing resolves
		const changes = [updateChange()];
		await structurePreserveUpdates({
			changes,
			projectId: "p1",
			userId: "u1",
		});
		expect(mocks.reanalyzeBodyByKind).not.toHaveBeenCalled();
		expect(
			(changes[0] as never as { description: { to: string } }).description
				.to,
		).toBe("analyzer regenerated body");
	});

	it("for an AC-only update, edits AC but does NOT rewrite the description", async () => {
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: "regenerated full body (should be ignored)",
			acceptanceCriteria: "GIVEN fixed WHEN retried THEN ok",
			fallbackUsed: false,
		});
		const changes = [
			updateChange({
				description: undefined,
				acceptanceCriteria: { from: "old ac", to: "new ac" },
			}),
		];
		await structurePreserveUpdates({
			changes,
			projectId: "p1",
			userId: "u1",
		});
		const c = changes[0] as never as {
			description?: { to: string };
			acceptanceCriteria?: { to: string };
		};
		// description was never proposed → left untouched (not rewritten)
		expect(c.description).toBeUndefined();
		expect(c.acceptanceCriteria?.to).toBe(
			"GIVEN fixed WHEN retried THEN ok",
		);
	});
});

afterEach(() => vi.useRealTimers());

describe("merge time budget", () => {
	it("keeps slow batches alive and defers aborted and unstarted proposals intact", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const changes: ChangeProposal["changes"] = Array.from(
			{ length: 6 },
			() =>
				updateChange({
					acceptanceCriteria: { from: "old AC", to: "proposed AC" },
				}),
		);
		const original = structuredClone(changes);
		mocks.reanalyzeBodyByKind.mockResolvedValueOnce({
			description: "merged",
			fallbackUsed: false,
		});
		mocks.reanalyzeBodyByKind.mockImplementation(
			({ abortSignal }) =>
				new Promise((resolve) => {
					setTimeout(
						() =>
							resolve({
								description: "old",
								fallbackUsed: true,
								fallbackReason: "aborted",
							}),
						31_000,
					);
					expect(abortSignal).toBe(controller.signal);
				}),
		);
		const pending = structurePreserveUpdates({
			changes,
			projectId: "p1",
			userId: "u1",
			abortSignal: controller.signal,
		});
		await vi.advanceTimersByTimeAsync(30_000);
		expect(
			mocks.heartbeat.mock.calls.filter(
				([arg]) => typeof arg === "object" && arg.keepalive,
			),
		).toHaveLength(2);
		controller.abort();
		await vi.advanceTimersByTimeAsync(1_000);
		await pending;
		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledTimes(4);
		expect(changes[0].structurePreserved).toBe(true);
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.stringContaining("cut short"),
			expect.objectContaining({
				merged: 1,
				heldBack: 0,
				deferredToApply: 5,
			}),
		);
		for (let i = 1; i < changes.length; i++) {
			expect(changes[i]).toEqual({
				...original[i],
				bodyMergeDeferred: true,
			});
		}
		expect(vi.getTimerCount()).toBe(0);
	});
	it("fires at the attempt deadline minus the post-processing reserve and cleans up", async () => {
		vi.useFakeTimers();
		const scope = createMergeDeadlineScope({
			deadlineMs: Date.now() + 60_000,
		});
		await vi.advanceTimersByTimeAsync(29_999);
		expect(scope.signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(scope.signal?.aborted).toBe(true);
		scope.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("forwards cancellation and disposes the deadline timer", () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const scope = createMergeDeadlineScope({
			deadlineMs: Date.now() + 60_000,
			cancellationSignal: controller.signal,
		});
		controller.abort();
		expect(scope.signal?.aborted).toBe(true);
		scope.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("is inert outside an activity", () => {
		const scope = createMergeDeadlineScope();
		expect(scope.signal).toBeUndefined();
		scope.dispose();
	});

	it("does not start a merge when the pass is already aborted", async () => {
		const changes: ChangeProposal["changes"] = Array.from(
			{ length: 5 },
			() => updateChange(),
		);
		const original = structuredClone(changes);
		await structurePreserveUpdates({
			changes,
			projectId: "p1",
			userId: "u1",
			abortSignal: AbortSignal.abort(),
		});
		expect(mocks.reanalyzeBodyByKind).not.toHaveBeenCalled();
		expect(changes).toEqual(
			original.map((c) => ({ ...c, bodyMergeDeferred: true })),
		);
	});

	it("uses the current attempt timestamp and cancellation signal from Temporal", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		mocks.current.mockReturnValueOnce({
			info: {
				currentAttemptScheduledTimestampMs: Date.now() - 20_000,
				startToCloseTimeoutMs: 60_000,
			},
			cancellationSignal: controller.signal,
		} as never);
		const scope = createMergeDeadlineScope();
		await vi.advanceTimersByTimeAsync(9_999);
		expect(scope.signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(scope.signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		scope.dispose();
	});

	it("cleans up an unused deadline and detaches cancellation", () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const scope = createMergeDeadlineScope({
			deadlineMs: Date.now() + 60_000,
			cancellationSignal: controller.signal,
		});
		scope.dispose();
		controller.abort();
		expect(scope.signal?.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps completed merges and excludes missing items from deferral counts", async () => {
		const controller = new AbortController();
		mocks.reanalyzeBodyByKind.mockImplementationOnce(async () => {
			controller.abort();
			return { description: "completed", fallbackUsed: false };
		});
		const changes: ChangeProposal["changes"] = [
			updateChange(),
			updateChange({ existingId: "missing" }),
			updateChange(),
		];
		await structurePreserveUpdates({
			changes,
			projectId: "p1",
			userId: "u1",
			abortSignal: controller.signal,
		});
		expect(changes[0]).toMatchObject({
			structurePreserved: true,
			description: { to: "completed" },
		});
		expect(changes[0].bodyMergeDeferred).toBeUndefined();
		expect(changes[1].bodyMergeDeferred).toBeUndefined();
		expect(changes[2].bodyMergeDeferred).toBe(true);
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.stringContaining("cut short"),
			expect.objectContaining({
				merged: 1,
				heldBack: 0,
				deferredToApply: 1,
			}),
		);
	});
	it.each([Number.NaN, Number.POSITIVE_INFINITY])(
		"treats non-finite deadline %s as cancellation only",
		async (deadlineMs) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			const scope = createMergeDeadlineScope({
				deadlineMs,
				cancellationSignal: controller.signal,
			});
			await vi.advanceTimersByTimeAsync(1_000_000);
			expect(scope.signal?.aborted).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
			controller.abort();
			expect(scope.signal?.aborted).toBe(true);
			scope.dispose();
		},
	);
	it("immediately aborts an already-past deadline", () => {
		vi.useFakeTimers();
		const scope = createMergeDeadlineScope({ deadlineMs: Date.now() - 1 });
		expect(scope.signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		scope.dispose();
	});
	it("immediately forwards already-cancelled attempts", () => {
		vi.useFakeTimers();
		const reason = new Error("Already cancelled");
		const scope = createMergeDeadlineScope({
			deadlineMs: Date.now() + 60_000,
			cancellationSignal: AbortSignal.abort(reason),
		});
		expect(scope.signal?.aborted).toBe(true);
		expect(scope.signal?.reason).toBe(reason);
		expect(vi.getTimerCount()).toBe(0);
		scope.dispose();
	});
});
