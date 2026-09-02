/**
 * Unit Tests for reconcileStoryTerminalStatus (leaf module)
 *
 * The STORY-only terminal-status reconcile extracted from pm-state-poll's
 * reconcileAdoStates (#1360). Exercises the five STORY outcomes plus the
 * manual-hide passthrough guard. Mirrors the mock pattern in pm-state-poll.test.ts.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/reconcile-story-terminal-status.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/database — only the symbols the leaf module imports.
const mockUserStoryUpdate = vi.fn();
const mockApplyTerminalClose = vi.fn();
const mockApplyTerminalUnhide = vi.fn();
const mockUpsertPendingChange = vi.fn();
const mockRecordAudit = vi.fn();
const mockClearPendingContentDrift = vi.fn();

// Wrapper-arrow form (matches pm-state-poll.test.ts): the closures defer the
// mock reference until call-time, so the hoisted factory does not touch the
// `const mock…` bindings before they initialize. Assertions target the
// module-scope mocks directly.
vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			update: (...args: unknown[]) => mockUserStoryUpdate(...args),
		},
	},
	applyTerminalClose: (...args: unknown[]) => mockApplyTerminalClose(...args),
	applyTerminalUnhide: (...args: unknown[]) =>
		mockApplyTerminalUnhide(...args),
	upsertPendingChange: (...args: unknown[]) =>
		mockUpsertPendingChange(...args),
	recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
	clearPendingContentDrift: (...args: unknown[]) =>
		mockClearPendingContentDrift(...args),
}));

import {
	classifyPmItem,
	reconcileStoryTerminalStatus,
} from "../src/activities/pm-integration/reconcile-story-terminal-status";

const baseTenant = { organizationId: "org-1", userId: "user-9" };
const terminalLc = new Set(["closed", "done", "removed"]);

function storyItem(over: Partial<{ state: string; isClosed: boolean | null }>) {
	return {
		externalId: "123",
		state: "Closed",
		stateChangedDate: null,
		title: null,
		description: null,
		isClosed: null,
		labels: [],
		...over,
	};
}

function fabric(
	over: Partial<{
		draftingStage: string;
		pmAutoHidden: boolean;
		/** Omit (default) to simulate a hand-built ref that never sets these
		 *  two — the reconcile then always writes (fail-safe). */
		pmTicketTerminal: boolean;
		pmTicketTerminalStatus: string | null;
	}>,
) {
	return {
		entityType: "STORY" as const,
		entityId: "story-1",
		draftingStage: "DRAFT",
		pmAutoHidden: false,
		lastSyncedPmHash: null,
		lastPmSyncStatus: null,
		...over,
	};
}

describe("reconcileStoryTerminalStatus", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUserStoryUpdate.mockResolvedValue({});
		mockApplyTerminalClose.mockResolvedValue({ applied: true });
		mockApplyTerminalUnhide.mockResolvedValue({ applied: true });
		mockUpsertPendingChange.mockResolvedValue({ action: "created" });
		mockClearPendingContentDrift.mockResolvedValue(0);
	});

	it("terminal + autoClose ON → auto-hidden", async () => {
		mockApplyTerminalClose.mockResolvedValue({ applied: true });
		const r = await reconcileStoryTerminalStatus({
			projectId: "proj-1",
			item: storyItem({ state: "Closed" }),
			fabricItem: fabric({}),
			terminalLc,
			autoCloseEnabled: true,
			tenant: baseTenant,
		});
		expect(r.action).toBe("auto-hidden");
		expect(r.terminalApplied).toBe(true);
		expect(mockApplyTerminalClose).toHaveBeenCalledWith(
			expect.objectContaining({
				entityType: "STORY",
				entityId: "story-1",
				markAutoHidden: true,
			}),
		);
		expect(mockRecordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "story.auto_hidden" }),
		);
		// Checkmark snapshot was written with the terminal flag.
		expect(mockUserStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			data: { pmTicketTerminal: true, pmTicketTerminalStatus: "Closed" },
		});
	});

	it("terminal + autoClose ON but already CLOSED → already-applied (guard no-op)", async () => {
		mockApplyTerminalClose.mockResolvedValue({ applied: false });
		const r = await reconcileStoryTerminalStatus({
			projectId: "proj-1",
			item: storyItem({ state: "Closed" }),
			// draftingStage DRAFT so the autoClose branch is entered, but the
			// guarded close returns applied:false (e.g. a concurrent writer won).
			fabricItem: fabric({}),
			terminalLc,
			autoCloseEnabled: true,
			tenant: baseTenant,
		});
		expect(r.action).toBe("already-applied");
		expect(r.terminalApplied).toBe(true);
		// No audit when nothing was applied.
		expect(mockRecordAudit).not.toHaveBeenCalled();
	});

	it("terminal + autoClose OFF → checkmark-only, no proposal", async () => {
		const r = await reconcileStoryTerminalStatus({
			projectId: "proj-1",
			item: storyItem({ state: "Closed" }),
			fabricItem: fabric({}),
			terminalLc,
			autoCloseEnabled: false,
			tenant: baseTenant,
		});
		expect(r.action).toBe("checkmark-only");
		expect(mockApplyTerminalClose).not.toHaveBeenCalled();
		expect(r.pendingChangesCreated).toBe(0);
	});

	it("reopened (CLOSED+pmAutoHidden) + autoClose ON → auto-unhid", async () => {
		mockApplyTerminalUnhide.mockResolvedValue({ applied: true });
		const r = await reconcileStoryTerminalStatus({
			projectId: "proj-1",
			item: storyItem({ state: "open", isClosed: false }),
			fabricItem: fabric({ draftingStage: "CLOSED", pmAutoHidden: true }),
			terminalLc,
			autoCloseEnabled: true,
			tenant: baseTenant,
		});
		expect(r.action).toBe("auto-unhid");
		expect(mockApplyTerminalUnhide).toHaveBeenCalledWith(
			expect.objectContaining({
				entityType: "STORY",
				entityId: "story-1",
			}),
		);
		expect(mockRecordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "story.auto_unhidden" }),
		);
	});

	it("reopened (CLOSED+pmAutoHidden) + autoClose ON but unhide no-op → already-applied (no audit)", async () => {
		mockApplyTerminalUnhide.mockResolvedValue({ applied: false });
		const r = await reconcileStoryTerminalStatus({
			projectId: "proj-1",
			item: storyItem({ state: "open", isClosed: false }),
			fabricItem: fabric({ draftingStage: "CLOSED", pmAutoHidden: true }),
			terminalLc,
			autoCloseEnabled: true,
			tenant: baseTenant,
		});
		expect(r.action).toBe("already-applied");
		expect(mockRecordAudit).not.toHaveBeenCalled();
	});

	it("reopened + autoClose OFF → unhide-proposed (+1)", async () => {
		mockUpsertPendingChange.mockResolvedValue({ action: "created" });
		const r = await reconcileStoryTerminalStatus({
			projectId: "proj-1",
			item: storyItem({ state: "open", isClosed: false }),
			fabricItem: fabric({ draftingStage: "CLOSED", pmAutoHidden: true }),
			terminalLc,
			autoCloseEnabled: false,
			tenant: baseTenant,
		});
		expect(r.action).toBe("unhide-proposed");
		expect(r.pendingChangesCreated).toBe(1);
		expect(mockUpsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({
				proposedAction: "UNHIDE",
				newState: "open",
				entityId: "story-1",
			}),
		);
		expect(mockApplyTerminalUnhide).not.toHaveBeenCalled();
	});

	it("reopened + autoClose OFF + upsert skipped → unhide-proposed (+0)", async () => {
		mockUpsertPendingChange.mockResolvedValue({ action: "skipped" });
		const r = await reconcileStoryTerminalStatus({
			projectId: "proj-1",
			item: storyItem({ state: "open", isClosed: false }),
			fabricItem: fabric({ draftingStage: "CLOSED", pmAutoHidden: true }),
			terminalLc,
			autoCloseEnabled: false,
			tenant: baseTenant,
		});
		expect(r.action).toBe("unhide-proposed");
		expect(r.pendingChangesCreated).toBe(0);
	});

	it("non-terminal & not a reopen → non-terminal-passthrough", async () => {
		const r = await reconcileStoryTerminalStatus({
			projectId: "proj-1",
			item: storyItem({ state: "Active", isClosed: false }),
			fabricItem: fabric({ draftingStage: "DRAFT", pmAutoHidden: false }),
			terminalLc,
			autoCloseEnabled: true,
			tenant: baseTenant,
		});
		expect(r.action).toBe("non-terminal-passthrough");
		expect(mockApplyTerminalUnhide).not.toHaveBeenCalled();
		expect(mockUpsertPendingChange).not.toHaveBeenCalled();
		// Snapshot cleared the terminal flag.
		expect(mockUserStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			data: { pmTicketTerminal: false, pmTicketTerminalStatus: null },
		});
	});

	it("non-terminal CLOSED + manual-hide (pmAutoHidden:false) → non-terminal-passthrough (NOT checkmark-only)", async () => {
		// A manually-closed/hidden story that is non-terminal upstream is NOT a
		// reopen-of-auto-hidden, so it must fall through (poll then runs
		// content-drift; Pull no-ops). Guards against the mistaken
		// "checkmark-only" expectation.
		const r = await reconcileStoryTerminalStatus({
			projectId: "proj-1",
			item: storyItem({ state: "Active", isClosed: false }),
			fabricItem: fabric({
				draftingStage: "CLOSED",
				pmAutoHidden: false,
			}),
			terminalLc,
			autoCloseEnabled: false,
			tenant: baseTenant,
		});
		expect(r.action).toBe("non-terminal-passthrough");
		expect(mockApplyTerminalUnhide).not.toHaveBeenCalled();
	});

	it("terminal → clears the story's pending CONTENT_DRIFT rows", async () => {
		await reconcileStoryTerminalStatus({
			projectId: "proj-1",
			item: storyItem({ state: "Closed" }),
			fabricItem: fabric({}),
			terminalLc,
			autoCloseEnabled: true,
			tenant: baseTenant,
		});
		expect(mockClearPendingContentDrift).toHaveBeenCalledWith({
			projectId: "proj-1",
			entityType: "STORY",
			entityId: "story-1",
		});
	});

	it("non-terminal passthrough → does NOT clear content drift", async () => {
		await reconcileStoryTerminalStatus({
			projectId: "proj-1",
			item: storyItem({ state: "In Progress" }),
			fabricItem: fabric({}),
			terminalLc,
			autoCloseEnabled: true,
			tenant: baseTenant,
		});
		expect(mockClearPendingContentDrift).not.toHaveBeenCalled();
	});

	describe("no-op write skip (hourly-poll write churn)", () => {
		it("terminal, checkmark already matches target → userStory.update NOT called, rest of the flow still runs", async () => {
			const r = await reconcileStoryTerminalStatus({
				projectId: "proj-1",
				item: storyItem({ state: "Closed" }),
				fabricItem: fabric({
					pmTicketTerminal: true,
					pmTicketTerminalStatus: "Closed",
				}),
				terminalLc,
				autoCloseEnabled: true,
				tenant: baseTenant,
			});
			expect(mockUserStoryUpdate).not.toHaveBeenCalled();
			// The rest of the terminal flow (content-drift clear, auto-close,
			// audit, and the returned result) still runs unchanged.
			expect(mockClearPendingContentDrift).toHaveBeenCalledWith({
				projectId: "proj-1",
				entityType: "STORY",
				entityId: "story-1",
			});
			expect(mockApplyTerminalClose).toHaveBeenCalled();
			expect(r.action).toBe("auto-hidden");
			expect(r.terminalApplied).toBe(true);
			expect(r.terminalStatusLabel).toBe("Closed");
		});

		it("non-terminal passthrough, checkmark already matches target (false/null) → userStory.update NOT called", async () => {
			const r = await reconcileStoryTerminalStatus({
				projectId: "proj-1",
				item: storyItem({ state: "Active", isClosed: false }),
				fabricItem: fabric({
					draftingStage: "DRAFT",
					pmAutoHidden: false,
					pmTicketTerminal: false,
					pmTicketTerminalStatus: null,
				}),
				terminalLc,
				autoCloseEnabled: true,
				tenant: baseTenant,
			});
			expect(mockUserStoryUpdate).not.toHaveBeenCalled();
			expect(r.action).toBe("non-terminal-passthrough");
		});

		it("terminal flag flips (false → true) → userStory.update IS called with the new values", async () => {
			const r = await reconcileStoryTerminalStatus({
				projectId: "proj-1",
				item: storyItem({ state: "Closed" }),
				fabricItem: fabric({
					pmTicketTerminal: false,
					pmTicketTerminalStatus: null,
				}),
				terminalLc,
				autoCloseEnabled: false,
				tenant: baseTenant,
			});
			expect(mockUserStoryUpdate).toHaveBeenCalledWith({
				where: { id: "story-1", projectId: "proj-1" },
				data: {
					pmTicketTerminal: true,
					pmTicketTerminalStatus: "Closed",
				},
			});
			expect(r.action).toBe("checkmark-only");
		});

		it("terminal flag unchanged but status LABEL changed → userStory.update IS called with the new label", async () => {
			// Same terminal flag (true), but the PM tool's status label moved
			// (e.g. "Done" → "Closed") — must still be treated as a real change.
			const r = await reconcileStoryTerminalStatus({
				projectId: "proj-1",
				item: storyItem({ state: "Closed" }),
				fabricItem: fabric({
					pmTicketTerminal: true,
					pmTicketTerminalStatus: "Done",
				}),
				terminalLc,
				autoCloseEnabled: false,
				tenant: baseTenant,
			});
			expect(mockUserStoryUpdate).toHaveBeenCalledWith({
				where: { id: "story-1", projectId: "proj-1" },
				data: {
					pmTicketTerminal: true,
					pmTicketTerminalStatus: "Closed",
				},
			});
			expect(r.action).toBe("checkmark-only");
		});

		it("ref without pmTicketTerminal/pmTicketTerminalStatus (hand-built site) → userStory.update IS called (existing behaviour, fail-safe)", async () => {
			// `fabric({})` never sets these two fields, matching the hand-built
			// FabricItemRef sites (gitlab-rest-story-sync.ts, story-sync.ts) that
			// don't come from `findFabricItemByExternalId`.
			await reconcileStoryTerminalStatus({
				projectId: "proj-1",
				item: storyItem({ state: "Closed" }),
				fabricItem: fabric({}),
				terminalLc,
				autoCloseEnabled: false,
				tenant: baseTenant,
			});
			expect(mockUserStoryUpdate).toHaveBeenCalledWith({
				where: { id: "story-1", projectId: "proj-1" },
				data: {
					pmTicketTerminal: true,
					pmTicketTerminalStatus: "Closed",
				},
			});
		});

		it("ref with only pmTicketTerminal (partial snapshot) → userStory.update IS still called (fail-safe)", async () => {
			// A partial snapshot must not be mistaken for a match: with only the
			// flag present and a non-terminal target (false/null), a missing
			// status normalised to null would wrongly look like a no-op.
			await reconcileStoryTerminalStatus({
				projectId: "proj-1",
				item: storyItem({ state: "Active", isClosed: false }),
				fabricItem: fabric({ pmTicketTerminal: false }),
				terminalLc,
				autoCloseEnabled: false,
				tenant: baseTenant,
			});
			expect(mockUserStoryUpdate).toHaveBeenCalledWith({
				where: { id: "story-1", projectId: "proj-1" },
				data: {
					pmTicketTerminal: false,
					pmTicketTerminalStatus: null,
				},
			});
		});
	});
});

describe("classifyPmItem", () => {
	const tlc = new Set(["closed", "done", "removed"]);
	const nonTerminalOpenStory = {
		draftingStage: "DRAFT",
		pmAutoHidden: false,
	};

	it("status-in-set → terminal, label = the matched status string", () => {
		expect(
			classifyPmItem(
				{ state: "Done", labels: [] },
				nonTerminalOpenStory,
				tlc,
			),
		).toEqual({ classification: "terminal", terminalStatusLabel: "Done" });
	});
	it("isClosed === true → terminal, label 'closed' (not hardcoded 'Closed')", () => {
		expect(
			classifyPmItem(
				{ state: "", isClosed: true, labels: [] },
				nonTerminalOpenStory,
				tlc,
			),
		).toEqual({
			classification: "terminal",
			terminalStatusLabel: "closed",
		});
	});
	it("terminal label match → terminal, label = the matched label", () => {
		expect(
			classifyPmItem(
				{ state: "open", labels: ["Done"] },
				nonTerminalOpenStory,
				tlc,
			),
		).toEqual({ classification: "terminal", terminalStatusLabel: "Done" });
	});
	it("non-terminal + CLOSED + pmAutoHidden → reopen", () => {
		expect(
			classifyPmItem(
				{ state: "In Progress", labels: [] },
				{ draftingStage: "CLOSED", pmAutoHidden: true },
				tlc,
			),
		).toEqual({ classification: "reopen", terminalStatusLabel: null });
	});
	it("non-terminal + not-CLOSED → passthrough", () => {
		expect(
			classifyPmItem(
				{ state: "In Progress", labels: [] },
				nonTerminalOpenStory,
				tlc,
			),
		).toEqual({ classification: "passthrough", terminalStatusLabel: null });
	});
	it("non-terminal + CLOSED but pmAutoHidden false → passthrough (manual hide guard)", () => {
		expect(
			classifyPmItem(
				{ state: "In Progress", labels: [] },
				{ draftingStage: "CLOSED", pmAutoHidden: false },
				tlc,
			),
		).toEqual({ classification: "passthrough", terminalStatusLabel: null });
	});
});
