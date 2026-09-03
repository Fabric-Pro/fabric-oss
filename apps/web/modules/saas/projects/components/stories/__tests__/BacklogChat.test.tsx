/**
 * BacklogChat — handover from the in-chat apply flow to the
 * failed-proposals count + Review proposals inbox.
 *
 * Sub-task 6.5 of the sync-failure-retry spec asserts that after a
 * polled apply progress reaches a terminal state, the BacklogChat
 * component invalidates the dedicated failed-count React Query so any
 * count consumer refetches without a page reload.
 *
 * BacklogChat is wired through CopilotKit and would normally need a
 * full Copilot harness to render. We mock `useCopilotAction` to capture
 * the registered actions, then invoke the `review_backlog_changes`
 * action's render handler — which exposes the `onApprove` callback we
 * want to exercise — directly. The callback drives the underlying
 * `applyChanges` + `applyProgress` polling against fake responses and
 * we then assert the invalidation key + that no failure toast was
 * rendered (CLAUDE.md "When Tests Fail" — the disappearing toast was
 * removed as part of this spec).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useCoAgentMock = vi.fn(() => ({ state: {}, setState: vi.fn() }));
const useCopilotActionMock = vi.fn();

// Hoisted before imports — vitest evaluates `vi.mock` factories above the
// rest of the file. The mock factories cannot capture closure refs to
// outer variables that aren't hoisted, so the spy refs are declared
// above.
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: (args: unknown) => useCoAgentMock(args),
	useCopilotAction: (args: unknown) => useCopilotActionMock(args),
	// BacklogChat reads the live chat (CopilotKit 1.52's supported hook) to
	// snapshot the conversation into the read-only Session history.
	useCopilotChatInternal: () => ({ messages: [] }),
}));
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: { children?: React.ReactNode }) => (
		<div data-testid="copilot-sidebar">{children}</div>
	),
}));
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));

vi.mock("@saas/shared/components/copilot/CopilotAssistantMessage", () => ({
	CopilotAssistantMessageForBacklogUpdater: () => null,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: null }),
}));

const applyChangesFn = vi.fn();
const applyProgressFn = vi.fn();
const startAnalysisFn = vi.fn();
const analysisProgressFn = vi.fn();
vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			backlog: {
				applyChanges: (...args: unknown[]) => applyChangesFn(...args),
				applyProgress: (...args: unknown[]) => applyProgressFn(...args),
				startAnalysis: (...args: unknown[]) => startAnalysisFn(...args),
				analysisProgress: (...args: unknown[]) =>
					analysisProgressFn(...args),
			},
		},
		agents: { conversations: { create: vi.fn() } },
		mcp: { configs: { list: vi.fn() } },
	},
}));

vi.mock("../../lib/teams-fetch-decision", () => ({
	resolveTeamsFetchDecision: () => ({
		fetchTeamsMessages: false,
		selectedChannelContextIds: [],
	}),
}));

vi.mock("../BacklogChangeProposal", () => ({
	BacklogChangeProposal: ({
		onApprove,
		decisionConflicts,
		decisionPrecheckPending,
	}: {
		onApprove: (...args: unknown[]) => unknown;
		decisionConflicts?: unknown;
		decisionPrecheckPending?: boolean;
	}) => {
		// Expose the onApprove callback + the decisionConflicts / pending props
		// on test-only handles so the outer test can trigger the apply flow and
		// assert what the review card received without staging a full review UI.
		const handle = globalThis as unknown as {
			__backlogProposalOnApprove?: (...args: unknown[]) => unknown;
			__backlogProposalDecisionConflicts?: unknown;
			__backlogProposalDecisionPrecheckPending?: boolean;
		};
		handle.__backlogProposalOnApprove = onApprove;
		handle.__backlogProposalDecisionConflicts = decisionConflicts;
		handle.__backlogProposalDecisionPrecheckPending =
			decisionPrecheckPending;
		return <div data-testid="backlog-change-proposal" />;
	},
}));

vi.mock("../ReviewSourcesSelector", () => ({
	ReviewSourcesSelector: () => null,
}));

import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { BacklogChat } from "../BacklogChat";

function renderBacklogChat() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	// The real provider, over the mocked `useCopilotChatInternal` above —
	// `BacklogChatPanel` mounts it in production, and `BacklogChat` reads the
	// live messages through it.
	const utils = render(
		<QueryClientProvider client={client}>
			<CopilotChatSessionProvider>
				<BacklogChat
					projectId="project_1"
					projectName="Test Project"
					hasTeamsIntegration={false}
					hasSlackIntegration={false}
					hasNotionIntegration={false}
					hasPMTool={false}
					backlogSummary="0 features"
					onClose={vi.fn()}
					onChangesApplied={vi.fn()}
				/>
			</CopilotChatSessionProvider>
		</QueryClientProvider>,
	);
	return { ...utils, client };
}

describe("BacklogChat — failed-count banner handover", () => {
	it("invalidates the failed-count query after a per-item-error apply progress lands", async () => {
		applyChangesFn.mockResolvedValue({
			workflowId: "wf_1",
			proposalId: "prop_1",
		});
		// First poll returns a terminal "completed" with errors — the
		// production code's path that calls `setApplyResult` with
		// status "failed" (because `appliedTotal === 0` and there are
		// progressErrors). This branch fires the failed-count
		// invalidation per spec §3.7c.
		applyProgressFn.mockResolvedValueOnce({
			status: "completed",
			message: "done",
			createdItems: [],
			updatedItems: [],
			errors: ["Item 2: Bearer token expired"],
		});

		const { client } = renderBacklogChat();
		const invalidateSpy = vi.spyOn(client, "invalidateQueries");

		// Pull the `review_backlog_changes` action's render callback
		// out of the mock-recorded calls. The render's
		// `BacklogChangeProposal` mock captured `onApprove` on the
		// global handle.
		const reviewCall = useCopilotActionMock.mock.calls.find(
			(call) =>
				(call[0] as { name?: string })?.name ===
				"review_backlog_changes",
		);
		if (!reviewCall) {
			throw new Error("review_backlog_changes action was not registered");
		}
		const reviewAction = reviewCall[0] as {
			renderAndWaitForResponse: (args: {
				args: unknown;
				respond: () => void;
			}) => React.ReactElement;
		};

		// Render the action's UI so the mocked BacklogChangeProposal
		// captures onApprove.
		const respond = vi.fn();
		const ui = reviewAction.renderAndWaitForResponse({
			args: { changes: [] },
			respond,
		});
		render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

		const onApprove = (
			globalThis as unknown as {
				__backlogProposalOnApprove?: (
					...args: unknown[]
				) => Promise<unknown>;
			}
		).__backlogProposalOnApprove;
		if (!onApprove) {
			throw new Error(
				"BacklogChangeProposal mock did not expose onApprove",
			);
		}

		// Now run the approve callback — it kicks off applyChanges +
		// polls applyProgress. We don't await respond's setTimeout —
		// the invalidation fires before the LLM-respond timer.
		await onApprove(
			[{ type: "feature", action: "create", title: { to: "X" } }],
			false,
			undefined,
		);

		// The invalidation MUST include the failed-count queryKey.
		const calls = invalidateSpy.mock.calls;
		const hit = calls.some(
			(c) =>
				Array.isArray((c[0] as { queryKey?: unknown[] })?.queryKey) &&
				(c[0] as { queryKey: unknown[] }).queryKey[0] ===
					"projects.backlog.proposals.failedCount",
		);
		expect(hit).toBe(true);
	});

	it("does NOT import sonner — the disappearing failure toast was removed (regression guard)", async () => {
		// Spec §3.7c removes the in-chat failure toast in favor of the
		// in-card applyResult summary + the Review proposals inbox. If a
		// future change wires `toast.error` back into BacklogChat, this
		// guard fires.
		const fs = await import("node:fs");
		const path = await import("node:path");
		const here = path.dirname(
			new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
		);
		const moduleText = fs.readFileSync(
			path.join(here, "..", "BacklogChat.tsx"),
			"utf8",
		);
		expect(moduleText).not.toMatch(/from\s+["']sonner["']/);
		expect(moduleText).not.toMatch(
			/\btoast\.(error|success|info|warning)\b/,
		);
	});
});

/**
 * Card #1365 regression: the interactive AI-Update decision pre-check is ASYNC.
 * The analysis workflow exposes the proposal at status "complete" and folds the
 * LLM judge's conflict findings into its queryable state a beat LATER. The
 * analyze poll returns on the first "complete" (NFR: never block generation on
 * the judge), so a background poll must keep running to pick up the late fold
 * and surface it on the already-rendered review card. Before the fix the poll
 * stopped on "complete" and the note never appeared (proven live on staging:
 * the workflow query carried the ADR conflict ~1s after the FE had returned).
 */
describe("BacklogChat — async decision pre-check note (card #1365)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		startAnalysisFn.mockReset();
		analysisProgressFn.mockReset();
		useCopilotActionMock.mockClear();
		const handle = globalThis as unknown as {
			__backlogProposalDecisionConflicts?: unknown;
			__backlogProposalDecisionPrecheckPending?: boolean;
		};
		handle.__backlogProposalDecisionConflicts = undefined;
		handle.__backlogProposalDecisionPrecheckPending = undefined;
	});
	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
	});

	it("keeps polling after 'complete' and folds the async conflicts onto the review card", async () => {
		const CONFLICTS = {
			checkedAt: "2026-07-10T13:03:58.184Z",
			status: "conflicts" as const,
			findings: [
				{
					decisionId: "dec_1",
					decisionIdentifier: "ADR-002",
					decisionTitle: "Primary accent color is blue",
					natureOfConflict:
						"The change switches the accent to green, violating ADR-002.",
					conflictType: "violates_accepted" as const,
					confidence: 0.98,
					changeRef: {
						index: 0,
						title: "Rebrand Primary Accent Color to Green",
					},
				},
			],
		};
		const PROPOSAL = {
			summary: "",
			contextSummary: "",
			changes: [
				{
					type: "feature",
					action: "create",
					title: { to: "Rebrand Primary Accent Color to Green" },
				},
			],
		};

		startAnalysisFn.mockResolvedValue({ workflowId: "wf_1" });
		// First poll (the analyze loop) exposes the proposal at "complete" with
		// NO pre-check — the judge hasn't folded it yet. Every later poll (the
		// background continuation) carries the folded conflicts.
		analysisProgressFn
			.mockResolvedValueOnce({
				progress: { status: "complete", message: "Analysis complete." },
				proposal: PROPOSAL,
			})
			.mockResolvedValue({
				progress: { status: "complete", message: "Analysis complete" },
				proposal: { ...PROPOSAL, decisionConflicts: CONFLICTS },
			});

		renderBacklogChat();

		const analyzeAction = useCopilotActionMock.mock.calls.find(
			(call) =>
				(call[0] as { name?: string })?.name === "analyze_backlog",
		)?.[0] as { handler: (args: unknown) => Promise<unknown> } | undefined;
		if (!analyzeAction) {
			throw new Error("analyze_backlog action was not registered");
		}

		// Drive the analyze handler: its own poll returns on the first
		// "complete" (no conflicts) and kicks off the background poll.
		await act(async () => {
			const done = analyzeAction.handler({});
			// analyze poll interval is 2000ms
			await vi.advanceTimersByTimeAsync(2500);
			await done;
		});

		// The old code stopped here (a single progress call). The fix keeps
		// polling; background interval is 2500ms.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});

		// Poll must have continued past the initial "complete".
		expect(analysisProgressFn.mock.calls.length).toBeGreaterThanOrEqual(2);

		// The latest-registered review action reads the updated state, so its
		// render hands the folded conflicts to the proposal card.
		const reviewAction = [...useCopilotActionMock.mock.calls]
			.reverse()
			.find(
				(call) =>
					(call[0] as { name?: string })?.name ===
					"review_backlog_changes",
			)?.[0] as
			| {
					renderAndWaitForResponse: (a: {
						args: unknown;
						respond: () => void;
					}) => React.ReactElement;
			  }
			| undefined;
		if (!reviewAction) {
			throw new Error("review_backlog_changes action was not registered");
		}

		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		await act(async () => {
			render(
				<QueryClientProvider client={client}>
					{reviewAction.renderAndWaitForResponse({
						args: { changes: PROPOSAL.changes },
						respond: vi.fn(),
					})}
				</QueryClientProvider>,
			);
		});

		const h = globalThis as unknown as {
			__backlogProposalDecisionConflicts?: unknown;
			__backlogProposalDecisionPrecheckPending?: boolean;
		};
		expect(h.__backlogProposalDecisionConflicts).toEqual(CONFLICTS);
		// Pending resolved to false once the conflicts folded in.
		expect(h.__backlogProposalDecisionPrecheckPending).toBe(false);
	});

	it("stops the poll as soon as a clean 'ok' result folds in — no wasted tail", async () => {
		const PROPOSAL = {
			summary: "",
			contextSummary: "",
			changes: [
				{
					type: "feature",
					action: "create",
					title: { to: "Some clean feature" },
				},
			],
		};
		startAnalysisFn.mockResolvedValue({ workflowId: "wf_ok" });
		// Analyze exposes the proposal with no pre-check; the background poll then
		// sees the judge's CLEAN result ({status:"ok"}) — its presence means the
		// judge finished, so the poll must stop immediately (not run 45s of calls).
		analysisProgressFn
			.mockResolvedValueOnce({
				progress: { status: "complete", message: "done" },
				proposal: PROPOSAL,
			})
			.mockResolvedValue({
				progress: { status: "complete", message: "done" },
				proposal: {
					...PROPOSAL,
					decisionConflicts: {
						checkedAt: "2026-07-10T00:00:00.000Z",
						status: "ok",
						findings: [],
					},
				},
			});

		renderBacklogChat();
		const analyzeAction = useCopilotActionMock.mock.calls.find(
			(call) =>
				(call[0] as { name?: string })?.name === "analyze_backlog",
		)?.[0] as { handler: (args: unknown) => Promise<unknown> } | undefined;
		if (!analyzeAction) {
			throw new Error("analyze_backlog action was not registered");
		}

		await act(async () => {
			const done = analyzeAction.handler({});
			await vi.advanceTimersByTimeAsync(2500);
			await done;
		});
		await act(async () => {
			// One background tick reaches the clean result and stops.
			await vi.advanceTimersByTimeAsync(3000);
		});
		const callsAfterResolve = analysisProgressFn.mock.calls.length;
		expect(callsAfterResolve).toBeLessThanOrEqual(3);

		// Advance well past the 45s window — a stopped poll makes NO further calls
		// (the old blind-poll behavior would have fired ~18 times here).
		await act(async () => {
			await vi.advanceTimersByTimeAsync(50000);
		});
		expect(analysisProgressFn.mock.calls.length).toBe(callsAfterResolve);

		const reviewAction = [...useCopilotActionMock.mock.calls]
			.reverse()
			.find(
				(call) =>
					(call[0] as { name?: string })?.name ===
					"review_backlog_changes",
			)?.[0] as
			| {
					renderAndWaitForResponse: (a: {
						args: unknown;
						respond: () => void;
					}) => React.ReactElement;
			  }
			| undefined;
		if (!reviewAction) {
			throw new Error("review_backlog_changes action was not registered");
		}
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		await act(async () => {
			render(
				<QueryClientProvider client={client}>
					{reviewAction.renderAndWaitForResponse({
						args: { changes: PROPOSAL.changes },
						respond: vi.fn(),
					})}
				</QueryClientProvider>,
			);
		});
		const h = globalThis as unknown as {
			__backlogProposalDecisionConflicts?: unknown;
			__backlogProposalDecisionPrecheckPending?: boolean;
		};
		// The clean "ok" result is now carried through (so the accept relay can
		// tell the server the check already ran clean); the render still shows no
		// note because it gates on `status === "conflicts"`.
		expect(h.__backlogProposalDecisionConflicts).toEqual({
			checkedAt: "2026-07-10T00:00:00.000Z",
			status: "ok",
			findings: [],
		});
		expect(h.__backlogProposalDecisionPrecheckPending).toBe(false);
	});

	it("retires the background poll on unmount — no further calls, no setState after unmount", async () => {
		const PROPOSAL = {
			summary: "",
			contextSummary: "",
			changes: [
				{
					type: "feature",
					action: "create",
					title: { to: "Feature" },
				},
			],
		};
		startAnalysisFn.mockResolvedValue({ workflowId: "wf_unmount" });
		// Judge never resolves within the test — the proposal keeps coming back
		// WITHOUT decisionConflicts, so the poll would keep going until unmount
		// cancels it.
		analysisProgressFn.mockResolvedValue({
			progress: { status: "complete", message: "done" },
			proposal: PROPOSAL,
		});

		const { unmount } = renderBacklogChat();
		const analyzeAction = useCopilotActionMock.mock.calls.find(
			(call) =>
				(call[0] as { name?: string })?.name === "analyze_backlog",
		)?.[0] as { handler: (args: unknown) => Promise<unknown> } | undefined;
		if (!analyzeAction) {
			throw new Error("analyze_backlog action was not registered");
		}

		await act(async () => {
			const done = analyzeAction.handler({});
			await vi.advanceTimersByTimeAsync(2500);
			await done;
		});
		const before = analysisProgressFn.mock.calls.length;

		// Close the panel while the poll is in flight; cleanup must retire it.
		unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20000);
		});
		// A retired poll issues no further progress reads (and never setState on
		// the unmounted component — no act warning / crash).
		expect(analysisProgressFn.mock.calls.length).toBe(before);
	});

	it("always clears the 'checking…' indicator when the poll window elapses without a result", async () => {
		// Regression for the staging bug where the indicator stuck forever: the
		// judge never folds a result within the poll window, so the poll must
		// clear "checking…" on timeout (its `finally`) — never leave it pending.
		const PROPOSAL = {
			summary: "",
			contextSummary: "",
			changes: [
				{
					type: "feature",
					action: "create",
					title: { to: "Feature" },
				},
			],
		};
		startAnalysisFn.mockResolvedValue({ workflowId: "wf_timeout" });
		// Every poll returns the proposal WITHOUT decisionConflicts (judge stuck).
		analysisProgressFn.mockResolvedValue({
			progress: { status: "complete", message: "done" },
			proposal: PROPOSAL,
		});

		renderBacklogChat();
		const analyzeAction = useCopilotActionMock.mock.calls.find(
			(call) =>
				(call[0] as { name?: string })?.name === "analyze_backlog",
		)?.[0] as { handler: (args: unknown) => Promise<unknown> } | undefined;
		if (!analyzeAction) {
			throw new Error("analyze_backlog action was not registered");
		}

		await act(async () => {
			const done = analyzeAction.handler({});
			await vi.advanceTimersByTimeAsync(2500);
			await done;
		});

		// Advance past the poll's 45s window — the `finally` must clear pending.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(46000);
		});

		const reviewAction = [...useCopilotActionMock.mock.calls]
			.reverse()
			.find(
				(call) =>
					(call[0] as { name?: string })?.name ===
					"review_backlog_changes",
			)?.[0] as
			| {
					renderAndWaitForResponse: (a: {
						args: unknown;
						respond: () => void;
					}) => React.ReactElement;
			  }
			| undefined;
		if (!reviewAction) {
			throw new Error("review_backlog_changes action was not registered");
		}
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		await act(async () => {
			render(
				<QueryClientProvider client={client}>
					{reviewAction.renderAndWaitForResponse({
						args: { changes: PROPOSAL.changes },
						respond: vi.fn(),
					})}
				</QueryClientProvider>,
			);
		});
		const h = globalThis as unknown as {
			__backlogProposalDecisionPrecheckPending?: boolean;
		};
		expect(h.__backlogProposalDecisionPrecheckPending).toBe(false);
	});
});
