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

const chatMessages = vi.hoisted(() => ({ current: [] as unknown[] }));
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
	useCopilotChatInternal: () => ({ messages: chatMessages.current }),
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
const createConversationFn = vi.fn();
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
		agents: {
			conversations: {
				create: (...args: unknown[]) => createConversationFn(...args),
			},
		},
		mcp: { configs: { list: vi.fn() } },
	},
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

function renderBacklogChat(hasSlackIntegration = false) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	// The real provider, over the mocked `useCopilotChatInternal` above —
	// `BacklogChatPanel` mounts it in production, and `BacklogChat` reads the
	// live messages through it.
	const chatTree = () => (
		<QueryClientProvider client={client}>
			<CopilotChatSessionProvider>
				<BacklogChat
					projectId="project_1"
					projectName="Test Project"
					hasTeamsIntegration={false}
					hasSlackIntegration={hasSlackIntegration}
					hasNotionIntegration={false}
					hasPMTool={false}
					backlogSummary="0 features"
					onClose={vi.fn()}
					onChangesApplied={vi.fn()}
				/>
			</CopilotChatSessionProvider>
		</QueryClientProvider>
	);
	const utils = render(chatTree());
	return {
		...utils,
		client,
		refreshMessages: () => utils.rerender(chatTree()),
	};
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

type CapturedAction = {
	handler: (args: Record<string, unknown>) => Promise<unknown>;
	render: (input: { status: string }) => React.ReactElement;
	renderAndWaitForResponse: (input: {
		respond: ReturnType<typeof vi.fn>;
	}) => React.ReactElement<{
		onConfirm: (result: typeof confirmedSources) => void;
		onCancel: () => void;
	}>;
};
const confirmedSources = {
	selectedMeetings: [
		{
			joinUrl: "https://example.com/meeting",
			startTime: "2026-10-20T10:00:00Z",
		},
	],
	selectedChannels: [{ projectContextId: "example-channel" }],
	daysBack: 14 as const,
};
function latestAction(name: string): CapturedAction {
	const registration = [...useCopilotActionMock.mock.calls]
		.reverse()
		.find((call) => (call[0] as { name: string }).name === name);
	if (!registration) {
		throw new Error(`Missing action: ${name}`);
	}
	return registration[0] as CapturedAction;
}
function confirmSources(cancel = false) {
	const respond = vi.fn();
	const selector = latestAction(
		"select_review_sources",
	).renderAndWaitForResponse({ respond });
	if (cancel) {
		selector.props.onCancel();
	} else {
		selector.props.onConfirm(confirmedSources);
	}
	return respond;
}

describe("BacklogChat confirmed analysis sources", () => {
	beforeEach(() => {
		chatMessages.current = [];
		useCopilotActionMock.mockClear();
		startAnalysisFn.mockReset();
		analysisProgressFn.mockReset();
		startAnalysisFn.mockRejectedValue(new Error("Input validation failed"));
	});

	it("uses confirmed sources when the model supplies empty meeting objects, including later calls", async () => {
		renderBacklogChat();
		confirmSources();
		for (let call = 0; call < 2; call++) {
			await act(async () => {
				await latestAction("analyze_backlog").handler({
					selectedMeetings: [{}],
					selectedChannels: [{}],
					daysBack: 90,
				});
			});
		}
		expect(startAnalysisFn).toHaveBeenCalledTimes(2);
		expect(startAnalysisFn).toHaveBeenLastCalledWith(
			expect.objectContaining({
				contextSources: expect.objectContaining({
					selectedMeetings: confirmedSources.selectedMeetings,
					selectedChannelContextIds: ["example-channel"],
					fetchTeamsMessages: true,
					daysBack: 14,
				}),
			}),
		);
	});

	it.each([
		{
			name: "channels only",
			sources: { selectedChannels: [{}] },
			meetings: [],
			channelIds: ["example-channel"],
			fetchTeamsMessages: true,
		},
		{
			name: "meetings only",
			sources: { selectedMeetings: [{}] },
			meetings: confirmedSources.selectedMeetings,
			channelIds: [],
			fetchTeamsMessages: false,
		},
	])(
		"substitutes confirmed values per field for $name",
		async ({ sources, meetings, channelIds, fetchTeamsMessages }) => {
			renderBacklogChat();
			confirmSources();
			await act(async () => {
				await latestAction("analyze_backlog").handler({
					...sources,
					daysBack: 90,
				});
			});
			expect(startAnalysisFn).toHaveBeenCalledTimes(1);
			expect(startAnalysisFn).toHaveBeenCalledWith(
				expect.objectContaining({
					contextSources: expect.objectContaining({
						selectedMeetings: meetings,
						selectedChannelContextIds: channelIds,
						fetchTeamsMessages,
						daysBack: 14,
					}),
				}),
			);
		},
	);

	it.each([
		{
			name: "confirmed meetings substituted for malformed ones",
			confirm: true,
			meetings: confirmedSources.selectedMeetings,
			fetchSlackMessages: false,
		},
		{
			name: "malformed meetings with no confirmed selection",
			confirm: false,
			meetings: [],
			fetchSlackMessages: true,
		},
	])(
		"decides Slack from the meetings actually sent: $name",
		async ({ confirm, meetings, fetchSlackMessages }) => {
			renderBacklogChat(true);
			if (confirm) {
				confirmSources();
			}
			await act(async () => {
				await latestAction("analyze_backlog").handler({
					selectedMeetings: [{}],
				});
			});
			expect(startAnalysisFn).toHaveBeenCalledWith(
				expect.objectContaining({
					contextSources: expect.objectContaining({
						selectedMeetings: meetings,
						selectedChannelContextIds: [],
						fetchSlackMessages,
					}),
				}),
			);
		},
	);

	it.each([{}, { selectedMeetings: [], selectedChannels: [] }])(
		"does not inject a prior confirmed selection when later args omit sources: %j",
		async (sources) => {
			renderBacklogChat();
			confirmSources();
			await act(async () => {
				await latestAction("analyze_backlog").handler({
					selectedMeetings: [{}],
				});
			});
			await act(async () => {
				await latestAction("analyze_backlog").handler({
					...sources,
					fetchSlackMessages: true,
					daysBack: 7,
				});
			});
			expect(startAnalysisFn).toHaveBeenCalledTimes(2);
			expect(startAnalysisFn).toHaveBeenLastCalledWith(
				expect.objectContaining({
					contextSources: expect.objectContaining({
						selectedMeetings: [],
						selectedChannelContextIds: [],
						fetchTeamsMessages: false,
						fetchSlackMessages: true,
						daysBack: 7,
					}),
				}),
			);
		},
	);
	it("allows a new user turn after the previous turn reaches the start failure cap", async () => {
		chatMessages.current = [{ role: "user", content: "Analyze Slack" }];
		const { refreshMessages } = renderBacklogChat();
		for (let call = 0; call < 3; call++) {
			await act(async () => {
				await latestAction("analyze_backlog").handler({});
			});
		}
		expect(startAnalysisFn).toHaveBeenCalledTimes(2);
		chatMessages.current = [
			...chatMessages.current,
			{ role: "assistant", content: "Could not start" },
			{ type: "human", content: "Try again" },
		];
		refreshMessages();
		await act(async () => {
			await latestAction("analyze_backlog").handler({});
		});
		expect(startAnalysisFn).toHaveBeenCalledTimes(3);
	});

	it("validates model options before starting analysis", async () => {
		renderBacklogChat();
		await act(async () => {
			await latestAction("analyze_backlog").handler({
				userPrompt: "   ",
				fetchSlackMessages: "false",
				notionPageIds: [{}, "", "  ", "example-page"],
				notionMcpConfigId: {},
			});
		});
		expect(startAnalysisFn).toHaveBeenCalledWith(
			expect.objectContaining({
				userPrompt: "Analyze context and suggest backlog updates",
				contextSources: expect.objectContaining({
					fetchSlackMessages: false,
					notionPageIds: ["example-page"],
					notionMcpConfigId: undefined,
				}),
			}),
		);
	});

	it("filters malformed fallback sources without a confirmed selection", async () => {
		renderBacklogChat();
		await act(async () => {
			await latestAction("analyze_backlog").handler({
				selectedMeetings: [{}],
				selectedChannels: [{}],
			});
		});
		expect(startAnalysisFn).toHaveBeenCalledWith(
			expect.objectContaining({
				contextSources: expect.objectContaining({
					selectedMeetings: [],
					selectedChannelContextIds: [],
					fetchTeamsMessages: false,
				}),
			}),
		);
	});

	it("stops API calls after two consecutive start failures and resets on a new selection", async () => {
		renderBacklogChat();
		for (let call = 0; call < 3; call++) {
			let result: unknown;
			await act(async () => {
				result = await latestAction("analyze_backlog").handler({});
			});
			expect(result).toMatch(/do not call analyze_backlog again/i);
			expect(result).toMatch(/tell the user/i);
			expect(result).toMatch(/Input validation failed/);
		}
		expect(startAnalysisFn).toHaveBeenCalledTimes(2);
		confirmSources();
		await act(async () => {
			await latestAction("analyze_backlog").handler({});
		});
		expect(startAnalysisFn).toHaveBeenCalledTimes(3);
	});

	it.each(["executing", "complete"])(
		"shows a failed card after a progress rejection while %s",
		async (status) => {
			vi.useFakeTimers();
			try {
				renderBacklogChat();
				startAnalysisFn.mockResolvedValue({
					workflowId: "example-workflow",
				});
				analysisProgressFn.mockRejectedValue(
					new Error("Progress unavailable"),
				);
				let run: Promise<unknown> | undefined;
				await act(async () => {
					run = latestAction("analyze_backlog").handler({});
					await Promise.resolve();
				});
				await act(async () => {
					await vi.advanceTimersByTimeAsync(2000);
					await run;
				});
				const card = render(
					latestAction("analyze_backlog").render({ status }),
				);
				expect(card.getByText("Analysis Failed")).toBeTruthy();
				expect(card.getByText("Progress unavailable")).toBeTruthy();
				expect(card.queryByText("Analyzing Context")).toBeNull();
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("shows a failed card before the tool render completes", async () => {
		renderBacklogChat();
		await act(async () => {
			await latestAction("analyze_backlog").handler({});
		});
		const card = render(
			latestAction("analyze_backlog").render({ status: "executing" }),
		);
		expect(card.getByText("Analysis Failed")).toBeTruthy();
		expect(card.getByText("Input validation failed")).toBeTruthy();
	});

	it("resets consecutive failures after a successful start and shows progress on a new run", async () => {
		vi.useFakeTimers();
		try {
			renderBacklogChat();
			confirmSources();
			await act(async () => {
				await latestAction("analyze_backlog").handler({});
			});
			startAnalysisFn.mockResolvedValueOnce({
				workflowId: "example-workflow",
			});
			analysisProgressFn.mockResolvedValue({
				progress: { status: "failed", message: "Workflow failed" },
			});
			let run: Promise<unknown> | undefined;
			await act(async () => {
				run = latestAction("analyze_backlog").handler({});
				await Promise.resolve();
			});
			const card = render(
				latestAction("analyze_backlog").render({ status: "executing" }),
			);
			expect(card.getByText("Analyzing Context")).toBeTruthy();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
				await run;
			});
			for (let call = 0; call < 2; call++) {
				await act(async () => {
					await latestAction("analyze_backlog").handler({
						selectedMeetings: [{}],
					});
				});
			}
			expect(startAnalysisFn).toHaveBeenCalledTimes(4);
			expect(startAnalysisFn).toHaveBeenLastCalledWith(
				expect.objectContaining({
					contextSources: expect.objectContaining({
						selectedMeetings: confirmedSources.selectedMeetings,
					}),
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains an empty confirmed selection on cancel and resets the failure limit", async () => {
		renderBacklogChat();
		for (let call = 0; call < 2; call++) {
			await act(async () => {
				await latestAction("analyze_backlog").handler({});
			});
		}
		const respond = confirmSources(true);
		expect(respond).toHaveBeenCalledWith({
			selectedMeetings: [],
			selectedChannels: [],
			daysBack: 30,
		});
		await act(async () => {
			await latestAction("analyze_backlog").handler(confirmedSources);
		});
		expect(startAnalysisFn).toHaveBeenLastCalledWith(
			expect.objectContaining({
				contextSources: expect.objectContaining({
					selectedMeetings: [],
					selectedChannelContextIds: [],
					daysBack: 30,
				}),
			}),
		);
		expect(startAnalysisFn).toHaveBeenCalledTimes(3);
	});
});

describe("BacklogChat — Slack selection defaults", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		createConversationFn.mockResolvedValue({ id: "example-conversation" });
		startAnalysisFn.mockReset();
		analysisProgressFn.mockReset();
		useCopilotActionMock.mockClear();
	});

	afterEach(() => {
		createConversationFn.mockReset();
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it.each([
		["meetings only", [], false],
		[
			"meetings and channels",
			[{ projectContextId: "example-channel" }],
			true,
		],
	] as const)("%s", async (_label, selectedChannels, expectedSlack) => {
		startAnalysisFn.mockResolvedValue({ workflowId: "example-workflow" });
		analysisProgressFn.mockResolvedValue({
			progress: { status: "complete", message: "Analysis complete." },
			proposal: {
				summary: "No changes needed.",
				contextSummary: "",
				changes: [],
				decisionConflicts: {
					status: "ok",
					findings: [],
					checkedAt: "2026-10-20T00:00:00.000Z",
				},
			},
		});
		const { unmount } = renderBacklogChat(true);
		const analyzeAction = useCopilotActionMock.mock.calls.find(
			(call) =>
				(call[0] as { name?: string })?.name === "analyze_backlog",
		)?.[0] as { handler: (args: unknown) => Promise<unknown> } | undefined;
		if (!analyzeAction) {
			throw new Error("analyze_backlog action was not registered");
		}
		await act(async () => {
			const done = analyzeAction.handler({
				userPrompt: "Update the backlog from the selected meeting",
				selectedMeetings: [{ joinUrl: "https://example.com/meeting" }],
				selectedChannels,
			});
			await vi.advanceTimersByTimeAsync(2500);
			await done;
		});
		expect(startAnalysisFn).toHaveBeenCalledWith(
			expect.objectContaining({
				contextSources: expect.objectContaining({
					fetchSlackMessages: expectedSlack,
				}),
			}),
		);
		unmount();
	});
});
