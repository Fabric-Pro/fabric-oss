/**
 * Tests for the analyzer's structure-preserving update pass
 * (`structurePreserveUpdates`), which rewrites resolved UPDATE proposals so the
 * proposed body preserves the existing item's structure.
 *
 * Verifies: merged result replaces description.to with from=true existing body;
 * safe-hold neutralizes the body diff and stamps bodyMergeFallback; unresolved /
 * non-update / title-only changes are skipped; feature AC handling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		reanalyzeBodyByKind: vi.fn(),
		findMany: vi.fn(),
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
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
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

import { structurePreserveUpdates } from "../src/activities/backlog-context/analyze-context";

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
