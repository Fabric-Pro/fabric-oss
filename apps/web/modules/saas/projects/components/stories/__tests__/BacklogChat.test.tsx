import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	messages: [] as unknown[],
	actions: new Map<string, any>(),
	setState: vi.fn(),
	agent: { state: {} as Record<string, unknown>, setState: vi.fn() },
	start: vi.fn(),
	poll: vi.fn(),
	apply: vi.fn(),
	applyPoll: vi.fn(),
	cancelApply: vi.fn(),
	applyRow: vi.fn(),
	conversation: vi.fn(),
	model: vi.fn(),
	bind: vi.fn(),
	proposal: null as any,
	selector: null as any,
	sources: null as any,
}));
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({ state: {}, setState: h.setState }),
	useCopilotAction: (action: any) => {
		h.actions.set(action.name, action);
	},
	useCopilotChatInternal: () => ({ messages: h.messages }),
}));
vi.mock("@copilotkit/react-core/v2", () => ({
	useAgent: () => ({ agent: h.agent }),
}));
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: { children?: ReactNode }) => (
		<div>{children}</div>
	),
}));
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));
vi.mock("@saas/shared/components/copilot/CopilotAssistantMessage", () => ({
	CopilotAssistantMessageForBacklogUpdater: () => null,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "example-org" }),
}));
vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			backlog: {
				startAnalysis: (...args: unknown[]) => h.start(...args),
				analysisProgress: (...args: unknown[]) => h.poll(...args),
				applyChanges: (...args: unknown[]) => h.apply(...args),
				applyProgress: (...args: unknown[]) => h.applyPoll(...args),
				getPendingProposal: (...args: unknown[]) => h.applyRow(...args),
				proposals: {
					cancel: (...args: unknown[]) => h.cancelApply(...args),
				},
			},
		},
		agents: { conversations: { create: () => h.conversation() } },
	},
}));
vi.mock("../../../../../shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			backlog: {
				listMeetings: {
					queryOptions: () => ({
						queryKey: ["example-meetings"],
						queryFn: async () => [],
					}),
				},
			},
		},
	},
}));
vi.mock("../ReviewSourcesSelector", () => ({
	ReviewSourcesSelector: (props: any) => {
		h.selector = props;
		return (
			<div data-testid="selector">
				<button
					type="button"
					onClick={() => props.onConfirm(h.sources)}
				>
					Confirm sources
				</button>
				<button type="button" onClick={props.onCancel}>
					Skip Teams
				</button>
			</div>
		);
	},
}));
vi.mock("../BacklogChangeProposal", () => ({
	BacklogChangeProposal: (props: any) => {
		h.proposal = props;
		return (
			<div data-testid="review">
				<p>{props.summary}</p>
				<button type="button" onClick={props.onReject}>
					Reject
				</button>
			</div>
		);
	},
}));
vi.mock(
	"../../../../../../../../agents/langchain/backlog-updater/utils",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		getAgentModelAsync: async () => ({
			invoke: h.model,
			bindTools: h.bind.mockImplementation(() => ({ invoke: h.model })),
		}),
	}),
);

import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { chatNode } from "../../../../../../../../agents/langchain/backlog-updater/nodes/chat-node";
import { normalizeMessages } from "../../../../../../../../agents/langchain/backlog-updater/normalize-messages";
import { BacklogChat } from "../BacklogChat";
import { BacklogFlowCard } from "../BacklogFlowCard";
import {
	BacklogFlowController,
	pollWorkflowProgress,
	REVIEW_UNAVAILABLE_RESULT,
	workflowPollMessage,
} from "../backlog-flow-controller";

const sources = {
	selectedMeetings: [{ joinUrl: "https://example.com/meeting" }],
	selectedChannels: [{ projectContextId: "example-channel" }],
	daysBack: 14,
};
const proposal = {
	summary: "Example proposal",
	contextSummary: "Context",
	changes: [
		{ type: "feature", action: "create", title: { to: "Example feature" } },
	],
	decisionConflicts: {
		status: "ok",
		findings: [],
		checkedAt: "2026-10-20T00:00:00Z",
	},
};
function mountChat(
	options: {
		teams?: boolean;
		notion?: boolean;
		slack?: boolean;
		hasPMTool?: boolean;
		pmConfig?: { mcpConfigId: string; containerId: string };
		onChangesApplied?: () => void;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const tree = () => (
		<QueryClientProvider client={client}>
			<CopilotChatSessionProvider>
				<BacklogChat
					projectId="example-project"
					projectName="Example"
					hasTeamsIntegration={options.teams ?? true}
					hasSlackIntegration={options.slack ?? false}
					hasNotionIntegration={options.notion ?? false}
					hasPMTool={options.hasPMTool ?? false}
					pmConfig={options.pmConfig}
					backlogSummary=""
					onClose={() => {}}
					onChangesApplied={options.onChangesApplied ?? (() => {})}
				/>
			</CopilotChatSessionProvider>
		</QueryClientProvider>
	);
	const view = render(tree());
	return { ...view, client, refresh: () => view.rerender(tree()) };
}
function entry(name = "select_review_sources", args = {}) {
	let result: any;
	act(() => {
		result = h.actions.get(name).handler(args);
	});
	if (typeof result === "string") {
		return { result };
	}
	const ui = h.actions
		.get(name)
		.render({ status: "complete", result }) as ReactElement;
	const client = new QueryClient();
	const card = render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
	return { result, card, ui, client };
}
async function tick(ms = 2000) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}
async function wrongModelContinuation(wrongTool: string, result: unknown) {
	h.model.mockResolvedValue({
		content: "",
		tool_calls: [{ name: wrongTool, id: "wrong-call", args: {} }],
		additional_kwargs: {},
	});
	const messages = normalizeMessages([
		{ role: "user", id: "example-message", content: "Review Teams" },
		{ role: "assistant", content: "" },
		{ role: "tool", toolCallId: "example-call", content: result },
	]);
	const command = await chatNode({
		projectId: "example-project",
		projectName: "Example",
		retryCount: 0,
		messages,
		tools: [{ name: wrongTool, parameters: {} }],
		reasoningByTurn: {},
	} as never);
	expect(h.bind).not.toHaveBeenCalled();
	expect((command.update as any).messages.at(-1).tool_calls).toEqual([]);
	// Also inject the forbidden output at the browser boundary, bypassing the agent filter.
	expect(
		h.actions.get(wrongTool).handler({
			selectedMeetings: [{}],
			userPrompt: "Wrong model intent",
		}),
	).toMatch(/already has a flow/);
}
beforeEach(() => {
	vi.useFakeTimers();
	h.actions.clear();
	h.proposal = null;
	h.sources = sources;
	for (const mock of [
		h.start,
		h.poll,
		h.apply,
		h.applyPoll,
		h.cancelApply,
		h.applyRow,
		h.conversation,
		h.model,
		h.bind,
		h.setState,
	]) {
		mock.mockReset();
	}
	h.messages = [
		{
			role: "user",
			id: "example-message",
			content: "Review Teams and meetings",
		},
	];
	h.cancelApply.mockResolvedValue({ cancelled: true });
	h.applyRow.mockResolvedValue({
		status: "APPLYING",
		applyWorkflowId: "example-apply",
	});
	h.start.mockResolvedValue({ workflowId: "example-workflow" });
	h.conversation.mockResolvedValue({ id: "example-conversation" });
	h.poll.mockResolvedValue({ progress: { status: "complete" }, proposal });
});
afterEach(() => {
	cleanup();
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("BacklogChat application sequencing", () => {
	// CopilotKit runs the agent again after a tool unless followUp is false
	// (@copilotkit/core executeSpecificTool); that run only narrated the card.
	it("registers every flow tool without a follow-up agent run", () => {
		mountChat();
		for (const name of [
			"select_review_sources",
			"select_notion_pages",
			"analyze_backlog",
			"review_backlog_changes",
		]) {
			expect(h.actions.get(name)?.followUp).toBe(false);
		}
	});
	it("shows a refused entry call's reason in its own card", () => {
		mountChat();
		entry();
		const refused = entry("analyze_backlog").result;
		const ui = h.actions
			.get("analyze_backlog")
			.render({ status: "complete", result: refused }) as ReactElement;
		const card = render(ui);
		expect(card.getByText(refused)).toBeTruthy();
	});
	it("shows why review_backlog_changes did nothing before a proposal exists", () => {
		mountChat();
		const review = h.actions.get("review_backlog_changes");
		let result: unknown;
		act(() => {
			result = review.handler({});
		});
		const card = render(
			review.render({ status: "complete", result }) as ReactElement,
		);
		expect(card.getByText(/no proposal waiting for review/i)).toBeTruthy();
	});
	it("advances under degraded history and wrong model tools, terminates on rejection, then admits a new user message", async () => {
		const chat = mountChat();
		entry();
		expect(screen.getAllByTestId("selector")).toHaveLength(1);
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick(0);
		expect(h.model).not.toHaveBeenCalled();
		await wrongModelContinuation("select_review_sources", sources);
		await tick();
		expect(h.start).toHaveBeenCalledTimes(1);
		expect(h.start).toHaveBeenCalledWith(
			expect.objectContaining({
				userPrompt: "Review Teams and meetings",
				operationKey: expect.any(String),
				contextSources: expect.objectContaining({
					selectedMeetings: sources.selectedMeetings,
					selectedChannelContextIds: ["example-channel"],
					daysBack: 14,
				}),
			}),
		);
		expect(screen.getAllByTestId("review")).toHaveLength(1);
		expect(h.model).toHaveBeenCalledTimes(1);
		await wrongModelContinuation("analyze_backlog", "Analysis complete.");
		fireEvent.click(screen.getByText("Reject"));
		expect(screen.getByText("Changes rejected")).toBeInTheDocument();
		await wrongModelContinuation(
			"analyze_backlog",
			"User rejected all changes",
		);
		await tick(10000);
		expect(h.start).toHaveBeenCalledTimes(1);
		h.messages = [
			...h.messages,
			{ role: "assistant", content: "Done" },
			{
				role: "user",
				id: "example-next-message",
				content: "Analyze a new request",
			},
		];
		chat.refresh();
		entry();
		expect(screen.getAllByTestId("selector")).toHaveLength(1);
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		expect(h.start).toHaveBeenCalledTimes(2);
	});
	it("claims double confirmation synchronously and survives the owning card remount", async () => {
		mountChat();
		const first = entry();
		const confirm = h.selector.onConfirm;
		act(() => {
			confirm(sources);
			confirm(sources);
		});
		first.card?.unmount();
		render(
			<QueryClientProvider client={new QueryClient()}>
				{first.ui}
			</QueryClientProvider>,
		);
		await tick();
		expect(h.start).toHaveBeenCalledTimes(1);
		expect(screen.getAllByTestId("review")).toHaveLength(1);
		expect(entry("analyze_backlog").result).toMatch(/already has a flow/);
	});
	it("runs mixed Teams and Notion selectors in order; Skip Teams differs from cancellation", async () => {
		mountChat({ notion: true });
		entry("select_review_sources", { includeNotion: true });
		fireEvent.click(screen.getByText("Skip Teams"));
		expect(screen.getByText("Notion Page Selection")).toBeInTheDocument();
		expect(h.start).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("Skip Notion"));
		await tick();
		expect(h.start).toHaveBeenCalledTimes(1);
		expect(h.start.mock.calls[0][0].contextSources).toMatchObject({
			selectedMeetings: [],
			selectedChannelContextIds: [],
			daysBack: 30,
		});
	});
	it("actual cancellation ends selection without starting analysis", async () => {
		mountChat();
		entry();
		fireEvent.click(screen.getByText("Cancel request"));
		await tick();
		expect(h.start).not.toHaveBeenCalled();
		expect(entry("analyze_backlog").result).toMatch(/already has a flow/);
	});
	it.each(["zero", "failure", "timeout", "read-error"])(
		"stops on %s and retains a known workflow for reconciliation",
		async (variant) => {
			if (variant === "zero") {
				h.poll.mockResolvedValue({
					progress: { status: "complete" },
					proposal: { ...proposal, changes: [] },
				});
			}
			if (variant === "failure") {
				h.poll.mockResolvedValue({
					progress: { status: "failed", message: "Workflow failed" },
				});
			}
			if (variant === "timeout") {
				h.poll.mockResolvedValue({ progress: { status: "analyzing" } });
			}
			if (variant === "read-error") {
				h.poll.mockRejectedValue(new Error("Progress unavailable"));
			}
			mountChat();
			entry();
			fireEvent.click(screen.getByText("Confirm sources"));
			await tick(
				variant === "timeout"
					? 2702000
					: variant === "read-error"
						? 124000
						: 2000,
			);
			expect(screen.queryByTestId("review")).toBeNull();
			expect(
				screen.getByText(
					variant === "zero"
						? "No Backlog Changes Needed"
						: variant === "timeout" || variant === "read-error"
							? "Analysis Timed Out"
							: "Analysis Failed",
				),
			).toBeInTheDocument();
			expect(entry("analyze_backlog").result).toMatch(
				/already has a flow/,
			);
			expect(h.start).toHaveBeenCalledTimes(1);
			if (variant !== "zero") {
				h.poll.mockResolvedValue({
					progress: { status: "complete" },
					proposal,
				});
				fireEvent.click(screen.getByText("Check existing analysis"));
				await tick(0);
				expect(h.poll).toHaveBeenLastCalledWith({
					projectId: "example-project",
					workflowId: "example-workflow",
				});
				expect(screen.getByTestId("review")).toBeInTheDocument();
				expect(h.start).toHaveBeenCalledTimes(1);
			}
		},
	);
	it("fences a late result for a superseded flow and stale selector callbacks", async () => {
		let complete!: (value: unknown) => void;
		h.poll.mockReturnValueOnce(
			new Promise((resolve) => {
				complete = resolve;
			}),
		);
		const chat = mountChat();
		entry();
		const oldSelector = h.selector.onConfirm;
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		fireEvent.click(screen.getByText("Start over"));
		h.messages = [
			{ role: "user", id: "example-new", content: "New request" },
		];
		chat.refresh();
		entry();
		act(() => {
			oldSelector(sources);
		});
		expect(
			screen.getByText("Superseded by a new request"),
		).toBeInTheDocument();
		expect(h.start).toHaveBeenCalledTimes(1);
		await act(async () => {
			complete({ progress: { status: "complete" }, proposal });
		});
		expect(screen.queryByTestId("review")).toBeNull();
		expect(screen.getAllByTestId("selector")).toHaveLength(1);
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		expect(h.start).toHaveBeenCalledTimes(2);
		expect(screen.getAllByTestId("review")).toHaveLength(1);
	});
	it("does not admit empty history or a tool result as a new request", () => {
		h.messages = [{ role: "tool", id: "example-tool", content: "Analyze" }];
		mountChat();
		expect(entry("analyze_backlog").result).toMatch(
			/no new message to start a request/,
		);
		expect(h.start).not.toHaveBeenCalled();
	});
	it.each([
		[[], false, undefined],
		[[{ projectContextId: "example-channel" }], true, undefined],
		[[], true, true],
	])(
		"decides Slack from stored confirmed sources (%j)",
		async (channels, expected, fetchSlackMessages) => {
			mountChat({ slack: true });
			h.sources = { ...sources, selectedChannels: channels };
			entry("select_review_sources", { fetchSlackMessages });
			fireEvent.click(screen.getByText("Confirm sources"));
			await tick();
			expect(
				h.start.mock.calls[0][0].contextSources.fetchSlackMessages,
			).toBe(expected);
		},
	);
});

describe("proposal-bound direct apply and decision precheck", () => {
	it("claims approval once, invalidates the failed-count query and carries the transcript", async () => {
		h.apply.mockResolvedValue({
			workflowId: "example-apply",
			proposalId: "example-proposal",
		});
		h.applyPoll.mockResolvedValue({
			status: "completed",
			createdItems: [],
			updatedItems: [],
			failedItems: [
				{ type: "feature", title: "Example", reason: "Unavailable" },
			],
		});
		mountChat();
		entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		const displayed = h.proposal;
		// Review owns its own query client; capture the invalidation at the shared prototype.
		const invalidation = vi.spyOn(
			QueryClient.prototype,
			"invalidateQueries",
		);
		await act(async () => {
			const applied = displayed.onApprove(proposal.changes, false);
			const duplicate = displayed.onApprove(proposal.changes, false);
			await vi.advanceTimersByTimeAsync(2000);
			await Promise.all([applied, duplicate]);
		});
		expect(h.apply).toHaveBeenCalledTimes(1);
		expect(h.apply.mock.calls[0][0].approvedChanges).toEqual(
			proposal.changes,
		);
		expect(h.apply.mock.calls[0][0].messages).toContainEqual({
			role: "user",
			content: "Review Teams and meetings",
		});
		expect(invalidation).toHaveBeenCalledWith({
			queryKey: [
				"projects.backlog.proposals.failedCount",
				"example-project",
				"example-org",
			],
		});
		invalidation.mockRestore();
		expect(entry("analyze_backlog").result).toMatch(/already has a flow/);
	});
	it.each(["ok", "conflicts", "timeout", "unmount"])(
		"folds async decision precheck or clears pending on %s",
		async (variant) => {
			const { decisionConflicts: _, ...pending } = proposal;
			h.poll.mockResolvedValueOnce({
				progress: { status: "complete" },
				proposal: pending,
			});
			const conflicts = {
				...proposal.decisionConflicts,
				status: variant,
				findings: [],
			};
			h.poll.mockResolvedValue({
				progress: { status: "complete" },
				proposal:
					variant === "timeout" || variant === "unmount"
						? pending
						: { ...proposal, decisionConflicts: conflicts },
			});
			const chat = mountChat();
			entry();
			fireEvent.click(screen.getByText("Confirm sources"));
			await tick();
			expect(h.proposal.decisionPrecheckPending).toBe(true);
			if (variant === "unmount") {
				const calls = h.poll.mock.calls.length;
				chat.unmount();
				await tick(20000);
				expect(h.poll).toHaveBeenCalledTimes(calls);
				return;
			}
			await tick(variant === "timeout" ? 48000 : 2500);
			expect(h.proposal.decisionPrecheckPending).toBe(false);
			if (variant !== "timeout") {
				expect(h.proposal.decisionConflicts).toEqual(conflicts);
			}
			const calls = h.poll.mock.calls.length;
			await tick(50000);
			expect(h.poll).toHaveBeenCalledTimes(calls);
		},
	);
});

it("rejects an approval from a superseded displayed proposal and ignores model-supplied proposals", async () => {
	const chat = mountChat();
	entry();
	fireEvent.click(screen.getByText("Confirm sources"));
	await tick();
	const oldReview = h.proposal;
	fireEvent.click(screen.getByText("Start over"));
	h.messages = [
		{ role: "user", id: "example-next", content: "New source selection" },
	];
	chat.refresh();
	entry();
	await act(async () => {
		await oldReview.onApprove(proposal.changes, false);
		oldReview.onReject();
	});
	expect(h.apply).not.toHaveBeenCalled();
	expect(screen.getByTestId("selector")).toBeInTheDocument();
	expect(
		h.actions
			.get("review_backlog_changes")
			.handler({ changes: proposal.changes }),
	).toBe(REVIEW_UNAVAILABLE_RESULT);
});
it("does not start a superseded request after conversation creation resolves", async () => {
	let created!: (value: unknown) => void;
	h.conversation.mockReturnValueOnce(
		new Promise((resolve) => {
			created = resolve;
		}),
	);
	const chat = mountChat();
	entry();
	fireEvent.click(screen.getByText("Confirm sources"));
	fireEvent.click(screen.getByText("Start over"));
	h.messages = [
		{ role: "user", id: "example-next", content: "New selection" },
	];
	chat.refresh();
	entry();
	await act(async () => {
		created({ id: "example-conversation" });
	});
	expect(h.start).not.toHaveBeenCalled();
	fireEvent.click(screen.getByText("Confirm sources"));
	await tick();
	expect(h.start).toHaveBeenCalledTimes(1);
});
it("renders why log context was unavailable next to the review", async () => {
	h.poll.mockResolvedValue({
		progress: {
			status: "complete",
			logContextNote: "Log context unavailable for this request.",
		},
		proposal,
	});
	mountChat();
	entry();
	fireEvent.click(screen.getByText("Confirm sources"));
	await tick();
	expect(
		screen.getByText("Log context unavailable for this request."),
	).toBeInTheDocument();
});

it.each(["complete", "fetching_pm"])(
	"renders why PM context was unavailable while %s",
	async (status) => {
		h.poll.mockResolvedValue({
			progress: {
				status,
				pmContextNote: "PM context unavailable for this request.",
			},
			proposal,
		});
		mountChat();
		entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		expect(
			screen.getByText("PM context unavailable for this request."),
		).toBeInTheDocument();
	},
);

it("keeps apply failures in the card instead of importing disappearing toasts", async () => {
	const { readFileSync } = await import("node:fs");
	for (const filename of ["BacklogChat.tsx", "BacklogFlowReview.tsx"]) {
		const source = readFileSync(
			`${process.cwd()}/modules/saas/projects/components/stories/${filename}`,
			"utf8",
		);
		expect(source).not.toMatch(/from\s+["']sonner["']/);
		expect(source).not.toMatch(/\btoast\.(error|success|info|warning)\b/);
	}
});

it("times out a hung progress read and fences its late result", async () => {
	let finish!: (value: unknown) => void;
	h.poll.mockReturnValue(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	mountChat();
	entry();
	fireEvent.click(screen.getByText("Confirm sources"));
	await tick(302000);
	expect(screen.getByText("Analysis Timed Out")).toBeInTheDocument();
	await act(async () => {
		finish({ progress: { status: "complete" }, proposal });
	});
	expect(screen.queryByTestId("review")).toBeNull();
	expect(h.start).toHaveBeenCalledTimes(1);
	h.poll.mockResolvedValue({ progress: { status: "complete" }, proposal });
	fireEvent.click(screen.getByText("Check existing analysis"));
	await tick(0);
	expect(screen.getByTestId("review")).toBeInTheDocument();
	expect(h.start).toHaveBeenCalledTimes(1);
});

it("accepts the displayed proposal while only its async decision note changes", async () => {
	const { decisionConflicts: _, ...pending } = proposal;
	h.poll.mockResolvedValueOnce({
		progress: { status: "complete" },
		proposal: pending,
	});
	h.poll.mockResolvedValue({ progress: { status: "complete" }, proposal });
	h.apply.mockResolvedValue({ workflowId: null });
	mountChat();
	entry();
	fireEvent.click(screen.getByText("Confirm sources"));
	await tick();
	const displayed = h.proposal;
	await tick(2500);
	await act(async () => {
		await displayed.onApprove(proposal.changes, false);
	});
	expect(h.apply).toHaveBeenCalledTimes(1);
});

describe("round 1 flow lifecycle", () => {
	it.each([
		["selecting", "The source selector is open."],
		["analyzing", "An analysis is running."],
		["reviewing", "A review is open."],
		["applying", "Changes are being applied."],
	])(
		"refuses a new message while %s with phase-specific guidance",
		async (phase, wording) => {
			h.poll.mockResolvedValue({
				progress: {
					status: phase === "analyzing" ? "analyzing" : "complete",
				},
				proposal,
			});
			h.apply.mockResolvedValue({
				workflowId: "example-apply",
				proposalId: "example-proposal",
			});
			h.applyPoll.mockResolvedValue({ status: "applying" });
			const chat = mountChat();
			entry();
			if (phase !== "selecting") {
				fireEvent.click(screen.getByText("Confirm sources"));
				await tick();
			}
			if (phase === "applying") {
				act(() => {
					void h.proposal.onApprove(proposal.changes, false);
				});
				await tick(0);
			}
			const starts = h.start.mock.calls.length;
			h.messages = [
				...h.messages,
				{
					role: "user",
					id: "example-interruption",
					content: "Also review this",
				},
			];
			chat.refresh();
			expect(entry("analyze_backlog").result).toContain(wording);
			await tick(0);
			expect(h.start).toHaveBeenCalledTimes(starts);
			if (phase === "applying") {
				expect(
					screen.queryByText("Start over"),
				).not.toBeInTheDocument();
				return;
			}
			expect(screen.getByText("Start over")).toBeInTheDocument();
			fireEvent.click(screen.getByText("Start over"));
			h.messages = [
				...h.messages,
				{
					role: "user",
					id: "example-replacement",
					content: "New request",
				},
			];
			chat.refresh();
			entry();
			expect(screen.getAllByTestId("selector")).toHaveLength(1);
			fireEvent.click(screen.getByText("Confirm sources"));
			await tick(0);
			expect(h.start).toHaveBeenCalledTimes(starts + 1);
		},
	);
	it("retries an uncertain analysis start using the same operation key and request", async () => {
		const jobs = new Set<string>();
		h.start.mockImplementation(async (input) => {
			const first = !jobs.has(input.operationKey);
			jobs.add(input.operationKey);
			if (first) {
				throw new Error("Response lost");
			}
			return { workflowId: "example-existing" };
		});
		mountChat();
		entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick(0);
		fireEvent.click(screen.getByText("Retry analysis"));
		await tick();
		expect(h.start).toHaveBeenCalledTimes(2);
		expect(h.start.mock.calls[1][0]).toEqual(h.start.mock.calls[0][0]);
		expect(jobs.size).toBe(1);
		expect(screen.getByTestId("review")).toBeInTheDocument();
	});
	it.each(["CONFLICT", "FORBIDDEN"])(
		"surfaces %s without an automatic start retry",
		async (code) => {
			h.start
				.mockRejectedValueOnce(new Error("Response unavailable"))
				.mockRejectedValue(
					Object.assign(new Error(`Start ${code}`), { code }),
				);
			mountChat();
			entry();
			fireEvent.click(screen.getByText("Confirm sources"));
			await tick(0);
			fireEvent.click(screen.getByText("Retry analysis"));
			await tick(20000);
			expect(screen.getByText(`Start ${code}`)).toBeInTheDocument();
			expect(screen.queryByText("Retry analysis")).toBeNull();
			expect(h.start).toHaveBeenCalledTimes(2);
		},
	);
	it.each(["poll-error", "poll-forbidden", "timeout"])(
		"keeps apply %s recovery and errors in controller state",
		async (variant) => {
			h.apply.mockImplementationOnce(async () => {
				if (variant === "throw") {
					throw new Error("Apply unavailable");
				}
				return {
					workflowId: "example-apply",
					proposalId: "example-proposal",
				};
			});
			if (variant === "poll-error" || variant === "poll-forbidden") {
				h.applyPoll.mockRejectedValue(
					Object.assign(new Error("Apply progress unavailable"), {
						code:
							variant === "poll-forbidden"
								? "FORBIDDEN"
								: undefined,
					}),
				);
			} else {
				h.applyPoll.mockResolvedValue({ status: "applying" });
			}
			mountChat();
			const owner = entry();
			fireEvent.click(screen.getByText("Confirm sources"));
			await tick();
			let done = Promise.resolve<unknown>(undefined);
			act(() => {
				done = h.proposal.onApprove(proposal.changes, false);
			});
			await tick(variant === "timeout" ? 2702000 : 124000);
			await done;
			expect(h.proposal.applyResult?.status).toBe("unconfirmed");
			expect(h.proposal.applyProgressMsg).toBeFalsy();
			expect(owner.card).toBeDefined();
			owner.card?.unmount();
			render(
				<QueryClientProvider client={new QueryClient()}>
					{owner.ui}
				</QueryClientProvider>,
			);
			expect(h.proposal.applyResult?.status).toBe("unconfirmed");
			h.apply.mockResolvedValue({ workflowId: null });
			await act(async () => {
				await h.proposal.onApprove(proposal.changes, false);
			});
			expect(h.apply).toHaveBeenCalledTimes(1);
		},
	);
	it("retries a lost apply response with the frozen approval and one server operation", async () => {
		const jobs = new Set<string>();
		h.apply.mockImplementation(async (request) => {
			expect(request.operationKey).toEqual(expect.any(String));
			const first = !jobs.has(request.operationKey);
			jobs.add(request.operationKey);
			if (first) {
				throw new Error("Response lost");
			}
			return {
				workflowId: "example-existing-apply",
				proposalId: "example-proposal",
			};
		});
		h.applyPoll.mockResolvedValue({
			status: "completed",
			createdItems: [],
		});
		const pmConfig = {
			mcpConfigId: "example-pm",
			containerId: "example-container",
		};
		const chat = mountChat({ hasPMTool: true, pmConfig });
		const owner = entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		const changes = structuredClone(proposal.changes);
		const overrides = { "0": { pushAnyway: true } };
		await act(async () => {
			await h.proposal.onApprove(changes, true, overrides);
		});
		expect(h.proposal.approval.state).toBe("approved");
		expect(screen.getByText("Retry apply")).toBeInTheDocument();
		const frozen = structuredClone(h.apply.mock.calls[0][0]);
		changes[0].title.to = "Mutated selection";
		overrides["0"].pushAnyway = false;
		pmConfig.containerId = "example-other-container";
		h.messages = [
			...h.messages,
			{ role: "user", id: "example-new", content: "New message" },
		];
		chat.refresh();
		owner.card?.unmount();
		render(
			<QueryClientProvider client={new QueryClient()}>
				{owner.ui}
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByText("Retry apply"));
		await tick();
		expect(h.apply.mock.calls[1][0]).toEqual(frozen);
		expect(jobs.size).toBe(1);
		expect(h.apply).toHaveBeenCalledTimes(2);
	});
	it.each([
		"BAD_REQUEST",
		"FORBIDDEN",
		"UNAUTHORIZED",
		"NOT_FOUND",
		"PRECONDITION_FAILED",
		"CONFLICT",
		"RESOURCE_EXHAUSTED",
	])(
		"keeps the original approval after a lost response and retry refusal %s",
		async (code) => {
			h.apply
				.mockRejectedValueOnce(new Error("Response lost"))
				.mockRejectedValueOnce(
					Object.assign(new Error("Retry refused"), { code }),
				)
				.mockResolvedValue({ workflowId: null });
			mountChat();
			entry();
			fireEvent.click(screen.getByText("Confirm sources"));
			await tick();
			await act(async () => {
				await h.proposal.onApprove(proposal.changes, false);
			});
			const original = structuredClone(h.apply.mock.calls[0][0]);
			fireEvent.click(screen.getByText("Retry apply"));
			await tick(0);
			expect(h.proposal.approval.state).toBe("approved");
			expect(screen.getByText("Retry apply")).toBeInTheDocument();
			expect(h.proposal.applyResult.message).toContain(
				"Review proposals",
			);
			// A stale approval callback cannot replace the frozen operation.
			await act(async () => {
				await h.proposal.onApprove(proposal.changes, false);
			});
			expect(h.apply).toHaveBeenCalledTimes(2);
			fireEvent.click(screen.getByText("Retry apply"));
			await tick(0);
			expect(h.apply).toHaveBeenCalledTimes(3);
			expect(h.apply.mock.calls.map(([request]) => request)).toEqual([
				original,
				original,
				original,
			]);
		},
	);
	it("returns an oversize first apply to review so approval can be reduced", async () => {
		h.apply.mockRejectedValueOnce(
			Object.assign(
				new Error("Batch too large; approve in smaller chunks"),
				{ code: "RESOURCE_EXHAUSTED" },
			),
		);
		mountChat();
		entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		await act(async () => {
			await h.proposal.onApprove(proposal.changes, false);
		});
		expect(h.proposal.approval.state).toBe("reviewing");
		expect(screen.queryByText("Retry apply")).toBeNull();
	});

	it.each([
		"BAD_REQUEST",
		"FORBIDDEN",
		"UNAUTHORIZED",
		"NOT_FOUND",
		"PRECONDITION_FAILED",
		"CONFLICT",
	])(
		"returns to review only for definite refusal %s and renews approval identity",
		async (code) => {
			h.apply
				.mockRejectedValueOnce(
					Object.assign(new Error("Refused"), { code }),
				)
				.mockResolvedValue({ workflowId: null });
			mountChat();
			entry();
			fireEvent.click(screen.getByText("Confirm sources"));
			await tick();
			await act(async () => {
				await h.proposal.onApprove(proposal.changes, false);
			});
			expect(h.proposal.approval.state).toBe("reviewing");
			expect(screen.queryByText("Retry apply")).toBeNull();
			await act(async () => {
				await h.proposal.onApprove(proposal.changes, false);
			});
			const keys = h.apply.mock.calls.map(
				([request]) => request.operationKey,
			);
			expect(keys[0]).toEqual(expect.any(String));
			expect(keys[1]).not.toBe(keys[0]);
		},
	);
	it.each([
		undefined,
		"INTERNAL_SERVER_ERROR",
		"SERVICE_UNAVAILABLE",
		"TIMEOUT",
	])(
		"keeps approval frozen after ambiguous apply failure %s",
		async (code) => {
			h.apply.mockRejectedValue(
				Object.assign(new Error("Unavailable"), { code }),
			);
			mountChat();
			entry();
			fireEvent.click(screen.getByText("Confirm sources"));
			await tick();
			await act(async () => {
				await h.proposal.onApprove(proposal.changes, false);
			});
			expect(h.proposal.approval.state).toBe("approved");
			expect(screen.getByText("Retry apply")).toBeInTheDocument();
		},
	);
	it("marks a hung apply read unconfirmed and admits a new flow", async () => {
		h.apply.mockResolvedValue({
			workflowId: "example-apply",
			proposalId: "example-proposal",
		});
		h.applyPoll.mockImplementation(() => new Promise(() => {}));
		const chat = mountChat();
		entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		act(() => {
			void h.proposal.onApprove(proposal.changes, false);
		});
		await tick(302000);
		expect(h.proposal.applyResult?.status).toBe("unconfirmed");
		expect(h.proposal.applyResult?.message).toContain("Review proposals");
		h.messages = [
			...h.messages,
			{ role: "user", id: "example-next", content: "Next request" },
		];
		chat.refresh();
		expect(entry().result.flowId).toEqual(expect.any(String));
		expect(h.applyPoll.mock.calls.length).toBeGreaterThan(1);
	});
	it("times out a hung apply start and retries the frozen operation", async () => {
		h.apply
			.mockImplementationOnce(() => new Promise(() => {}))
			.mockResolvedValue({ workflowId: null });
		mountChat();
		entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		act(() => {
			void h.proposal.onApprove(proposal.changes, false);
		});
		await tick(302000);
		fireEvent.click(screen.getByText("Retry apply"));
		await tick(0);
		expect(h.apply.mock.calls[1][0]).toEqual(h.apply.mock.calls[0][0]);
	});
	it("bounds a hung analysis start and retries the same operation key", async () => {
		h.start
			.mockImplementationOnce(() => new Promise(() => {}))
			.mockResolvedValue({ workflowId: "example-workflow" });
		mountChat();
		entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick(302000);
		fireEvent.click(screen.getByText("Retry analysis"));
		await tick();
		expect(h.start.mock.calls[1][0]).toEqual(h.start.mock.calls[0][0]);
		expect(screen.getByTestId("review")).toBeInTheDocument();
	});
	it.each([false, true])(
		"hides recovery controls on a replaced failed analysis (workflow known=%s)",
		async (known) => {
			if (known) {
				h.poll.mockRejectedValue(new Error("Poll failed"));
			} else {
				h.start.mockRejectedValue(new Error("Start failed"));
			}
			const chat = mountChat();
			entry();
			fireEvent.click(screen.getByText("Confirm sources"));
			await tick(known ? 124000 : 2000);
			expect(
				screen.getByText(
					known ? "Check existing analysis" : "Retry analysis",
				),
			).toBeInTheDocument();
			h.messages = [
				...h.messages,
				{
					role: "user",
					id: "example-replacement",
					content: "New request",
				},
			];
			chat.refresh();
			entry();
			expect(screen.queryByText("Retry analysis")).toBeNull();
			expect(screen.queryByText("Check existing analysis")).toBeNull();
		},
	);

	it("preserves applying progress and partial failure/outage results across remount", async () => {
		h.apply.mockResolvedValue({
			workflowId: "example-apply",
			proposalId: "example-proposal",
		});
		h.applyPoll
			.mockResolvedValueOnce({
				status: "applying",
				message: "Applying item",
			})
			.mockResolvedValue({
				status: "completed",
				createdItems: [
					{ identifier: "EX-1", title: "Example", type: "feature" },
				],
				failedItems: [
					{ title: "Other", type: "feature", reason: "Unavailable" },
				],
				pmSyncOutage: {
					tool: "Example PM",
					errorClass: "unavailable",
					count: 1,
					items: [],
				},
			});
		mountChat();
		const owner = entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		let done = Promise.resolve<unknown>(undefined);
		act(() => {
			done = h.proposal.onApprove(proposal.changes, false);
		});
		await tick();
		expect(owner.card).toBeDefined();
		owner.card?.unmount();
		const remount = render(
			<QueryClientProvider client={new QueryClient()}>
				{owner.ui}
			</QueryClientProvider>,
		);
		expect(h.proposal.applyProgressMsg).toBe("Applying item");
		expect(h.proposal.onCancelApply).toBeTypeOf("function");
		await tick();
		await done;
		remount.unmount();
		render(
			<QueryClientProvider client={new QueryClient()}>
				{owner.ui}
			</QueryClientProvider>,
		);
		expect(h.proposal.applyResult).toMatchObject({
			failedCount: 1,
			pmSyncOutage: { count: 1 },
		});
		expect(h.apply).toHaveBeenCalledTimes(1);
	});
	it("uses a validated model prompt for a clarifying exchange", async () => {
		h.messages = [
			{ role: "user", id: "example-first", content: "Review billing" },
			{ role: "assistant", content: "Which conversations?" },
			{ role: "user", id: "example-answer", content: "Teams this week" },
		];
		mountChat();
		entry("analyze_backlog", {
			userPrompt: "Review billing changes from Teams this week",
		});
		await tick();
		expect(h.start.mock.calls[0][0].userPrompt).toBe(
			"Review billing changes from Teams this week",
		);
	});
	it.each([undefined, "   "])(
		"joins genuine messages when model intent is empty (%s)",
		async (userPrompt) => {
			h.messages = [
				{
					role: "user",
					id: "example-first",
					content: "Review billing",
				},
				{ role: "assistant", content: "Which conversations?" },
				{
					role: "user",
					id: "example-answer",
					content: "Teams this week",
				},
			];
			mountChat();
			entry("analyze_backlog", { userPrompt });
			await tick();
			expect(h.start.mock.calls[0][0].userPrompt).toBe(
				"Review billing\n\nTeams this week",
			);
		},
	);
	it.each([
		[
			{ type: "text", text: "Review billing" },
			{
				type: "image_url",
				image_url: { url: "https://example.com/image.png" },
			},
		],
		[
			{
				type: "image_url",
				image_url: { url: "https://example.com/image.png" },
			},
		],
	])("admits content-part messages: %j", async (...parts) => {
		h.messages = [{ role: "user", id: "example-image", content: parts }];
		mountChat();
		entry("analyze_backlog");
		await tick();
		expect(h.start).toHaveBeenCalledTimes(1);
		expect(h.start.mock.calls[0][0].userPrompt).toBe(
			parts.some((p) => p.type === "text")
				? "Review billing"
				: "Analyze selected context and suggest backlog updates.",
		);
	});
	it("continues reconciling a known workflow and treats missing changes as no changes", async () => {
		h.poll.mockRejectedValue(new Error("Unavailable"));
		mountChat();
		entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick(124000);
		h.poll
			.mockResolvedValueOnce({ progress: { status: "analyzing" } })
			.mockResolvedValue({
				progress: { status: "complete" },
				proposal: { summary: "None" },
			});
		fireEvent.click(screen.getByText("Check existing analysis"));
		await tick(6000);
		expect(
			screen.getByText("No Backlog Changes Needed"),
		).toBeInTheDocument();
		expect(h.start).toHaveBeenCalledTimes(1);
	});
	it("clears the decision indicator after a hung precheck read", async () => {
		const { decisionConflicts: _, ...pending } = proposal;
		h.poll
			.mockResolvedValueOnce({
				progress: { status: "complete" },
				proposal: pending,
			})
			.mockReturnValue(new Promise(() => {}));
		mountChat();
		entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		expect(h.proposal.decisionPrecheckPending).toBe(true);
		await tick(48000);
		expect(h.proposal.decisionPrecheckPending).toBe(false);
	});
});

it("reads current PM configuration and completion callback from a memoised review render", async () => {
	h.apply.mockResolvedValue({ workflowId: "example-apply" });
	h.applyPoll.mockResolvedValue({ status: "completed", createdItems: [{}] });
	const oldCallback = vi.fn();
	const newCallback = vi.fn();
	const options = {
		hasPMTool: false,
		pmConfig: {
			mcpConfigId: "example-old",
			containerId: "example-old-container",
		},
		onChangesApplied: oldCallback,
	};
	const chat = mountChat(options);
	const owner = entry();
	fireEvent.click(screen.getByText("Confirm sources"));
	await tick();
	options.hasPMTool = true;
	options.pmConfig = {
		mcpConfigId: "example-new",
		containerId: "example-new-container",
	};
	options.onChangesApplied = newCallback;
	chat.refresh();
	let done = Promise.resolve<unknown>(undefined);
	act(() => {
		done = h.proposal.onApprove(
			proposal.changes,
			true,
			{ 0: { skip: true } },
			[0],
		);
	});
	await tick(3000);
	await done;
	expect(h.apply).toHaveBeenCalledWith(
		expect.objectContaining({
			syncToPM: true,
			pmConfig: options.pmConfig,
			approvedChangeIndexes: [0],
			pmSyncOverrides: { 0: { skip: true } },
			offeredChanges: proposal.changes.map((c) => ({
				action: c.action,
				type: c.type,
				title: c.title.to,
			})),
		}),
	);
	expect(newCallback).toHaveBeenCalledTimes(1);
	expect(oldCallback).not.toHaveBeenCalled();
	expect(owner.result.flowId).toBeTruthy();
});

it("fences an unmounted apply before conversation creation resolves", async () => {
	let resolveConversation: (value: { id: string }) => void = () => {};
	h.conversation.mockReturnValue(
		new Promise((resolve) => {
			resolveConversation = resolve;
		}),
	);
	// The failed analysis lookup leaves the apply to retry conversation creation.
	h.conversation.mockRejectedValueOnce(
		new Error("Conversation temporarily unavailable"),
	);
	const chat = mountChat();
	entry();
	fireEvent.click(screen.getByText("Confirm sources"));
	await tick();
	let done = Promise.resolve<unknown>(undefined);
	act(() => {
		done = h.proposal.onApprove(proposal.changes, false);
	});
	await tick(0);
	chat.unmount();
	await act(async () => {
		resolveConversation({ id: "example-delayed-conversation" });
	});
	await tick(0);
	await done;
	expect(h.apply).not.toHaveBeenCalled();
});

it.each(["applying", "done-approved"])(
	"preserves %s state and hides Start over",
	async (phase) => {
		const controller = new BacklogFlowController();
		const services = {
			start: vi
				.fn()
				.mockResolvedValue({ workflowId: "example-analysis" }),
			poll: vi.fn().mockResolvedValue({
				progress: { status: "complete" },
				proposal,
			}),
		};
		const admitted = controller.admit(
			{ id: "example-request", content: "Review context" },
			"analyze_backlog",
			[],
			services,
			{ intakeMode: "standard" },
		);
		if (typeof admitted === "string") {
			throw new Error(admitted);
		}
		await tick();
		let finish = () => {};
		const applying = controller.applyProposal(
			admitted.flowId,
			proposal,
			1,
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		controller.patchApply(admitted.flowId, {
			workflowId: "example-apply",
			progress: "Applying example item",
			result:
				phase === "done-approved"
					? {
							status: "success",
							createdCount: 1,
							updatedCount: 0,
							failedCount: 0,
							batchTotal: 1,
							syncedToPM: false,
							items: [],
							message: "Applied example item",
						}
					: undefined,
		});
		if (phase === "done-approved") {
			finish();
			await applying;
		}
		render(
			<BacklogFlowCard
				controller={controller}
				flowId={admitted.flowId}
				projectId="example-project"
				organizationId="example-org"
				renderReview={(flow) => (
					<output>
						{flow.apply?.result?.message ?? flow.apply?.progress}
					</output>
				)}
			/>,
		);
		const before = controller.current();
		expect.soft(screen.queryByText("Start over")).not.toBeInTheDocument();
		act(() => {
			controller.startOver(admitted.flowId);
		});
		expect.soft(controller.current()).toBe(before);
		expect
			.soft(
				screen.getByText(
					phase === "applying"
						? "Applying example item"
						: "Applied example item",
				),
			)
			.toBeInTheDocument();
		if (phase === "applying") {
			await act(async () => {
				finish();
				await applying;
			});
		}
		controller.stop();
	},
);

it("seeds the project and integration context into the agent before the first run (Fizzy #3102)", () => {
	h.agent.setState.mockClear();
	mountChat();
	expect(h.agent.setState).toHaveBeenCalledWith(
		expect.objectContaining({
			projectId: "example-project",
			projectName: "Example",
			hasTeamsIntegration: true,
			backlogSummary: "",
		}),
	);
});

it("re-seeds a registered agent that replaces the provisional one, keeping its live state (Fizzy #3102)", () => {
	const provisional = h.agent;
	const registered = {
		state: {
			retryCount: 2,
			reasoningByTurn: { "turn-1": "example reasoning" },
			error: "example error",
		} as Record<string, unknown>,
		setState: vi.fn(),
	};
	try {
		const chat = mountChat();
		h.agent = registered;
		chat.refresh();
		expect(registered.setState).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "example-project",
				hasTeamsIntegration: true,
				retryCount: 2,
				reasoningByTurn: { "turn-1": "example reasoning" },
				error: "example error",
			}),
		);
	} finally {
		h.agent = provisional;
	}
});

describe("long-running workflow polling", () => {
	async function beginApply() {
		h.apply.mockResolvedValue({
			workflowId: "example-apply",
			proposalId: "example-proposal",
		});
		const onChangesApplied = vi.fn();
		const chat = mountChat({ onChangesApplied });
		const owner = entry();
		if (!owner.client) {
			throw new Error("Expected a flow card");
		}
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		const invalidate = vi.spyOn(owner.client, "invalidateQueries");
		let applyDone!: Promise<unknown>;
		act(() => {
			applyDone = h.proposal.onApprove(proposal.changes, false);
		});
		await tick(0);
		return { onChangesApplied, invalidate, chat, owner, applyDone };
	}
	it("ends complete analysis without a proposal and displays the skipped reason", async () => {
		h.poll.mockResolvedValue({
			progress: {
				status: "complete",
				message: "Selected meetings have no transcript.",
			},
			proposal: null,
		});
		const chat = mountChat();
		entry("analyze_backlog");
		await tick(2000);
		expect(
			screen.getByText("No Backlog Changes Needed"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Selected meetings have no transcript."),
		).toBeInTheDocument();
		const calls = h.poll.mock.calls.length;
		await tick(20000);
		expect(h.poll).toHaveBeenCalledTimes(calls);
		h.messages = [
			...h.messages,
			{
				role: "user",
				id: "example-after-empty",
				content: "Review again",
			},
		];
		chat.refresh();
		expect(entry().result.flowId).toEqual(expect.any(String));
	});
	it("ends server-cancelled analysis neutrally and allows a new request", async () => {
		h.poll.mockResolvedValue({
			progress: {
				status: "cancelled",
				message: "Analysis cancelled by user",
			},
			proposal: null,
		});
		const chat = mountChat();
		entry("analyze_backlog");
		await tick(2000);
		const message = screen.getByText("Analysis cancelled.");
		expect(message.closest("[aria-live]")).toHaveAttribute(
			"aria-live",
			"polite",
		);
		expect(screen.queryByText("Analysis Failed")).toBeNull();
		const calls = h.poll.mock.calls.length;
		await tick(20000);
		expect(h.poll).toHaveBeenCalledTimes(calls);
		h.messages = [
			...h.messages,
			{
				role: "user",
				id: "example-after-cancelled",
				content: "Review again",
			},
		];
		chat.refresh();
		expect(entry().result.flowId).toEqual(expect.any(String));
	});
	it.each(["Cancelled", "TimedOut"])(
		"uses the matching %s row over terminal failed progress",
		async (errorClass) => {
			const { onChangesApplied, applyDone } = await beginApply();
			h.applyPoll.mockResolvedValue({
				status: "failed",
				message: "Workflow terminated",
			});
			h.applyRow.mockResolvedValue({
				status: "FAILED",
				applyWorkflowId: "example-apply",
				errorClass,
				errorMessage: "Example stopped apply",
			});
			await tick(2000);
			await applyDone;
			expect(h.proposal.applyResult).toMatchObject({
				status: errorClass === "Cancelled" ? "unconfirmed" : "failed",
				message:
					errorClass === "Cancelled"
						? "Apply cancelled. You can retry it from Review proposals."
						: "Example stopped apply",
			});
			expect(onChangesApplied).toHaveBeenCalledTimes(1);
		},
	);
	it("checks a failed apply row even inside the row-check interval", async () => {
		const { onChangesApplied } = await beginApply();
		h.applyPoll
			.mockResolvedValueOnce({ status: "applying" })
			.mockResolvedValue({
				status: "failed",
				message: "Workflow terminated",
			});
		await tick(2000);
		h.applyRow.mockResolvedValue({
			status: "FAILED",
			applyWorkflowId: "example-apply",
			errorClass: "Cancelled",
		});
		await tick(2000);
		expect(h.proposal.applyResult?.status).toBe("unconfirmed");
		expect(onChangesApplied).toHaveBeenCalledTimes(1);
	});
	it("uses a confirmed banner cancellation after a racing failed read finishes first", async () => {
		const { onChangesApplied } = await beginApply();
		let finishCancel!: (value: { cancelled: boolean }) => void;
		h.cancelApply.mockReturnValue(
			new Promise((resolve) => {
				finishCancel = resolve;
			}),
		);
		act(() => {
			void h.proposal.onCancelApply();
		});
		h.applyPoll.mockResolvedValue({
			status: "failed",
			message: "Workflow terminated",
		});
		await tick(2000);
		await act(async () => {
			finishCancel({ cancelled: true });
		});
		expect(h.proposal.applyResult?.status).toBe("unconfirmed");
		expect(h.proposal.applyResult?.message).toBe(
			"Apply cancelled. You can retry it from Review proposals.",
		);
		// The failed progress and subsequent cancel acknowledgement each refresh.
		expect(onChangesApplied).toHaveBeenCalledTimes(2);
	});

	it("keeps banner cancellation when a terminal failed row read settles late", async () => {
		const { onChangesApplied, applyDone } = await beginApply();
		h.applyPoll.mockResolvedValue({
			status: "failed",
			message: "Workflow terminated",
		});
		let finishRow!: (row: unknown) => void;
		h.applyRow.mockReturnValue(
			new Promise((resolve) => {
				finishRow = resolve;
			}),
		);
		await tick(2000);
		expect(h.proposal.onCancelApply).toEqual(expect.any(Function));
		await act(async () => {
			await h.proposal.onCancelApply();
		});
		await applyDone;
		await act(async () => {
			finishRow({
				status: "FAILED",
				applyWorkflowId: "example-apply",
				errorClass: "TimedOut",
			});
		});
		expect(h.proposal.applyResult?.status).toBe("unconfirmed");
		expect(onChangesApplied).toHaveBeenCalledTimes(1);
	});
	it("uses only the slow hint for generic analysis and apply placeholders", async () => {
		h.poll.mockResolvedValue({ progress: { status: "analyzing" } });
		mountChat();
		entry("analyze_backlog");
		await tick(300000);
		const message = screen.getByText(/Still analyzing/);
		expect(message.textContent).not.toMatch(
			/Analyzing\.\.\.|leave this page/,
		);
		h.poll.mockResolvedValue({
			progress: { status: "complete" },
			proposal,
		});
		await tick(10000);
		h.apply.mockResolvedValue({
			workflowId: "example-apply",
			proposalId: "example-proposal",
		});
		h.applyPoll.mockResolvedValue({ status: "applying" });
		act(() => {
			void h.proposal.onApprove(proposal.changes, false);
		});
		await tick(300000);
		expect(h.proposal.applyProgressMsg).toMatch(/^Still applying/);
		expect(h.proposal.applyProgressMsg).not.toContain("Applying...");
	});

	it("keeps partial success when a syncing read races the workflow's FAILED default row", async () => {
		const { onChangesApplied } = await beginApply();
		h.applyPoll
			.mockResolvedValueOnce({ status: "syncing_pm" })
			.mockResolvedValue({
				status: "completed",
				createdItems: [
					{
						identifier: "EX-1",
						title: "Example feature",
						type: "feature",
					},
				],
				failedItems: [
					{
						title: "Other feature",
						type: "feature",
						reason: "Example item error",
					},
				],
			});
		h.applyRow.mockResolvedValue({
			status: "FAILED",
			applyWorkflowId: "example-apply",
			errorClass: "default",
			errorMessage: "Example partial apply",
		});
		await tick(4000);
		expect(h.proposal.applyResult).toMatchObject({
			status: "success",
			createdCount: 1,
			failedCount: 1,
		});
		expect(onChangesApplied).toHaveBeenCalledTimes(1);
	});
	it("removes abort listeners after each wait instead of retaining one across the poll loop", async () => {
		const abort = new AbortController();
		const added = vi.spyOn(abort.signal, "addEventListener");
		const removed = vi.spyOn(abort.signal, "removeEventListener");
		const polling = pollWorkflowProgress(
			async () => "example progress",
			() => {},
			() => true,
			true,
			abort.signal,
		);
		expect(await polling.next()).toMatchObject({ done: false });
		expect(added).toHaveBeenCalledTimes(1);
		expect(removed).toHaveBeenCalledTimes(1);
		const waiting = polling.next();
		abort.abort();
		expect(await waiting).toMatchObject({ done: true });
		expect(removed.mock.calls.length).toBe(added.mock.calls.length);
	});
	it("ends banner cancellation promptly during a hung read and frees the chat", async () => {
		const { onChangesApplied, invalidate, chat, applyDone } =
			await beginApply();
		h.applyPoll.mockImplementation(() => new Promise(() => {}));
		await tick(2000);
		await act(async () => {
			await h.proposal.onCancelApply();
		});
		await applyDone;
		expect(h.proposal.applyResult).toMatchObject({
			status: "unconfirmed",
			message: "Apply cancelled. You can retry it from Review proposals.",
		});
		expect(h.proposal.onCancelApply).toBeUndefined();
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: [
				"projects.backlog.proposals.failedCount",
				"example-project",
				"example-org",
			],
		});
		expect(onChangesApplied).toHaveBeenCalledTimes(1);
		const calls = h.applyPoll.mock.calls.length;
		await tick(32000);
		expect(h.applyPoll).toHaveBeenCalledTimes(calls);
		h.messages = [
			...h.messages,
			{
				role: "user",
				id: "example-after-cancel",
				content: "Review another batch",
			},
		];
		chat.refresh();
		expect(entry().result.flowId).toEqual(expect.any(String));
	});
	it("ends server cancellation before the proposal row is stamped neutrally", async () => {
		const { onChangesApplied, invalidate, applyDone } = await beginApply();
		h.applyRow.mockResolvedValue({
			status: "APPLYING",
			applyWorkflowId: "example-apply",
		});
		h.applyPoll.mockResolvedValue({
			status: "cancelled",
			message: "Apply cancelled.",
		});
		await tick(2000);
		await applyDone;
		expect(h.proposal.applyResult).toMatchObject({
			status: "unconfirmed",
			message: "Apply cancelled. You can retry it from Review proposals.",
		});
		expect(onChangesApplied).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(h.cancelApply).not.toHaveBeenCalled();
	});
	it.each(["watchdog", "unknown stop"])(
		"refreshes the roadmap for a %s failure before the proposal row is stamped",
		async (kind) => {
			const { onChangesApplied, invalidate, applyDone, chat, owner } =
				await beginApply();
			h.applyRow.mockResolvedValue({
				status: "APPLYING",
				applyWorkflowId: "example-apply",
			});
			h.applyPoll.mockResolvedValue({
				status: "failed",
				message:
					kind === "watchdog"
						? "Apply stopped because it stopped making progress. Open Review proposals to retry it."
						: "Apply was stopped.",
			});
			owner.card?.unmount();
			chat.unmount();
			await tick(2000);
			await applyDone;
			expect(invalidate).toHaveBeenCalledTimes(1);
			expect(onChangesApplied).toHaveBeenCalledTimes(1);
		},
	);

	it("ends a server cancelled status neutrally and refreshes the roadmap", async () => {
		const { onChangesApplied, invalidate, applyDone } = await beginApply();
		h.applyPoll.mockResolvedValue({
			status: "cancelled",
			message: "Apply cancelled by user",
		});
		await tick(2000);
		await applyDone;
		expect(h.proposal.applyResult).toMatchObject({
			status: "unconfirmed",
			message: "Apply cancelled. You can retry it from Review proposals.",
		});
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(onChangesApplied).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("Retry apply")).toBeNull();
	});
	it("does not cancel when the procedure returns cancelled false", async () => {
		await beginApply();
		h.cancelApply.mockResolvedValue({ cancelled: false });
		h.applyPoll.mockResolvedValue({ status: "applying" });
		await act(async () => {
			await h.proposal.onCancelApply();
		});
		expect(h.proposal.applyResult).toBeNull();
		h.applyPoll.mockResolvedValue({
			status: "completed",
			createdItems: [],
		});
		await tick(2000);
		expect(h.proposal.applyResult?.status).toBe("success");
	});
	it("keeps completion when it arrives before the cancel response", async () => {
		await beginApply();
		let finishCancel!: (value: { cancelled: boolean }) => void;
		h.cancelApply.mockReturnValue(
			new Promise((resolve) => {
				finishCancel = resolve;
			}),
		);
		act(() => {
			void h.proposal.onCancelApply();
		});
		h.applyPoll.mockResolvedValue({
			status: "completed",
			createdItems: [],
		});
		await tick(2000);
		await act(async () => {
			finishCancel({ cancelled: true });
		});
		expect(h.proposal.applyResult?.status).toBe("success");
	});
	it("keeps cancellation when a previously dispatched progress read completes late", async () => {
		await beginApply();
		let finishRead!: (value: unknown) => void;
		h.applyPoll.mockReturnValue(
			new Promise((resolve) => {
				finishRead = resolve;
			}),
		);
		await tick(2000);
		await act(async () => {
			await h.proposal.onCancelApply();
		});
		await act(async () => {
			finishRead({ status: "completed", createdItems: [] });
		});
		expect(h.proposal.applyResult?.message).toBe(
			"Apply cancelled. You can retry it from Review proposals.",
		);
	});
	it("fences a cancelled apply's late read after a newer flow reaches review", async () => {
		const { chat, onChangesApplied, applyDone } = await beginApply();
		let finishRead!: (value: unknown) => void;
		h.applyPoll.mockReturnValue(
			new Promise((resolve) => {
				finishRead = resolve;
			}),
		);
		await tick(2000);
		await act(async () => {
			await h.proposal.onCancelApply();
		});
		await applyDone;
		h.messages = [
			...h.messages,
			{
				role: "user",
				id: "example-new-flow",
				content: "Review next batch",
			},
		];
		chat.refresh();
		expect(entry("analyze_backlog").result.flowId).toEqual(
			expect.any(String),
		);
		await tick(2000);
		expect(h.proposal.approval.state).toBe("reviewing");
		await act(async () => {
			finishRead({ status: "completed", createdItems: [] });
		});
		expect(h.proposal.approval.state).toBe("reviewing");
		expect(h.proposal.applyResult).toBeNull();
		expect(onChangesApplied).toHaveBeenCalledTimes(1);
	});

	it("refreshes the roadmap and failed count when apply completes after panel unmount", async () => {
		const { onChangesApplied, invalidate, chat, owner } =
			await beginApply();
		h.applyPoll
			.mockResolvedValueOnce({ status: "applying" })
			.mockResolvedValue({ status: "completed", createdItems: [] });
		await tick(2000);
		owner.card?.unmount();
		chat.unmount();
		await tick(2000);
		expect(onChangesApplied).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledTimes(1);
	});
	it("uses accurate slow and unconfirmed copy and refreshes on give-up", async () => {
		const { onChangesApplied, invalidate } = await beginApply();
		h.applyPoll.mockResolvedValue({ status: "applying" });
		await tick(300000);
		expect(h.proposal.applyProgressMsg).not.toMatch(
			/results appear in Review proposals|Failed/,
		);
		expect(h.proposal.applyProgressMsg).toContain(
			"keeps running if you leave this page",
		);
		await tick(2400000);
		expect(h.proposal.applyResult.message).toContain(
			"new items are on the roadmap",
		);
		expect(h.proposal.applyResult.message).not.toMatch(
			/for its result|Failed/,
		);
		expect(onChangesApplied).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledTimes(1);
	});
	it.each(["Cancelled", "TimedOut"])(
		"stops stale non-terminal progress when the same workflow's row reports %s",
		async (errorClass) => {
			const { onChangesApplied } = await beginApply();
			h.applyPoll.mockResolvedValue({ status: "applying" });
			h.applyRow.mockResolvedValue({
				status: "FAILED",
				applyWorkflowId: "example-apply",
				errorClass,
				errorMessage: "Example stopped apply",
			});
			await tick(12000);
			expect(h.proposal.applyResult?.status).toBe(
				errorClass === "Cancelled" ? "unconfirmed" : "failed",
			);
			expect(h.proposal.applyResult?.message).toBe(
				errorClass === "Cancelled"
					? "Apply cancelled. You can retry it from Review proposals."
					: "Example stopped apply",
			);
			expect(onChangesApplied).toHaveBeenCalledTimes(1);
		},
	);
	it("ignores a replacement workflow's failed proposal row", async () => {
		await beginApply();
		h.applyPoll.mockResolvedValue({ status: "applying" });
		h.applyRow.mockResolvedValue({
			status: "FAILED",
			applyWorkflowId: "example-new-apply",
			errorClass: "TimedOut",
		});
		await tick(12000);
		expect(h.proposal.applyResult).toBeNull();
		h.applyPoll.mockResolvedValue({
			status: "completed",
			createdItems: [],
		});
		await tick(2000);
		expect(h.proposal.applyResult?.status).toBe("success");
	});
	it("preserves the checking analysis message until its first read settles", async () => {
		h.poll.mockRejectedValue(new Error("Unavailable"));
		mountChat();
		entry("analyze_backlog");
		await tick(124000);
		h.poll.mockImplementation(() => new Promise(() => {}));
		fireEvent.click(screen.getByText("Check existing analysis"));
		await tick(0);
		expect(
			screen.getByText("Checking existing analysis..."),
		).toBeInTheDocument();
	});
	it("completes an apply after six minutes and shows the slow hint with server progress", async () => {
		const { onChangesApplied } = await beginApply();
		const began = Date.now();
		h.applyPoll.mockImplementation(async () =>
			Date.now() - began >= 360000
				? { status: "completed", createdItems: [] }
				: { status: "applying", message: "Applying example batch" },
		);
		await tick(300000);
		expect(h.proposal.applyProgressMsg).toContain(
			"taking longer than usual",
		);
		expect(h.proposal.applyProgressMsg).toContain("Applying example batch");
		const calls = h.applyPoll.mock.calls.length;
		await tick(9000);
		expect(h.applyPoll).toHaveBeenCalledTimes(calls);
		await tick(61000);
		expect(h.proposal.applyResult?.status).toBe("success");
		expect(onChangesApplied).toHaveBeenCalledTimes(1);
	});
	it("shows the slow hint even while an individual apply read hangs across five minutes", async () => {
		await beginApply();
		const began = Date.now();
		h.applyPoll.mockImplementation(() =>
			Date.now() - began >= 298000
				? new Promise(() => {})
				: Promise.resolve({
						status: "applying",
						message: "Applying example batch",
					}),
		);
		await tick(300000);
		expect(h.proposal.applyProgressMsg).toContain(
			"taking longer than usual",
		);
		expect(h.proposal.applyProgressMsg).toContain("Applying example batch");
	});
	it("recovers from rejected and NOT_FOUND apply reads", async () => {
		await beginApply();
		h.applyPoll
			.mockRejectedValueOnce(new Error("Unavailable"))
			.mockRejectedValueOnce(
				Object.assign(new Error("Restarting"), { code: "NOT_FOUND" }),
			)
			.mockResolvedValue({ status: "completed", createdItems: [] });
		await tick(6000);
		expect(h.proposal.applyResult?.status).toBe("success");
	});
	it("stops consecutive failed apply reads with a neutral result and no fresh retry", async () => {
		const { onChangesApplied, invalidate } = await beginApply();
		h.applyPoll.mockRejectedValue(
			Object.assign(new Error("Restarting"), { code: "NOT_FOUND" }),
		);
		await tick(124000);
		expect(h.proposal.applyResult).toMatchObject({
			status: "unconfirmed",
			failedCount: 0,
		});
		expect(h.proposal.applyResult.message).toContain(
			"may still be running",
		);
		expect(h.proposal.applyResult.message).not.toContain("Failed");
		expect(h.proposal.approval.state).toBe("approved");
		expect(screen.queryByText("Retry apply")).toBeNull();
		expect(onChangesApplied).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledTimes(1);
	});
	it("keeps an unconfirmed dispatched retry out of apply-failed", async () => {
		h.apply
			.mockRejectedValueOnce(new Error("Response lost"))
			.mockResolvedValue({ workflowId: "example-existing-apply" });
		h.applyPoll.mockRejectedValue(new Error("Unavailable"));
		mountChat();
		entry();
		fireEvent.click(screen.getByText("Confirm sources"));
		await tick();
		await act(async () => {
			await h.proposal.onApprove(proposal.changes, false);
		});
		fireEvent.click(screen.getByText("Retry apply"));
		await tick(124000);
		expect(h.proposal.applyResult?.status).toBe("unconfirmed");
		expect(h.proposal.approval.state).toBe("approved");
		expect(screen.queryByText("Retry apply")).toBeNull();
		await act(async () => {
			await h.proposal.onApprove(proposal.changes, false);
		});
		expect(h.apply).toHaveBeenCalledTimes(2);
		expect(h.apply.mock.calls[1][0]).toEqual(h.apply.mock.calls[0][0]);
	});
	it("resets the apply failed-read window after a successful read", async () => {
		await beginApply();
		const began = Date.now();
		let recovered = false;
		h.applyPoll.mockImplementation(async () => {
			const elapsed = Date.now() - began;
			if (elapsed >= 220000) {
				return { status: "completed", createdItems: [] };
			}
			if (!recovered && elapsed >= 100000) {
				recovered = true;
				return { status: "applying" };
			}
			throw new Error("Unavailable");
		});
		await tick(222000);
		expect(h.proposal.applyResult?.status).toBe("success");
	});
	it("bounds hung apply reads and leaves the result unconfirmed", async () => {
		await beginApply();
		h.applyPoll.mockImplementation(() => new Promise(() => {}));
		await tick(160000);
		expect(h.proposal.applyResult?.status).toBe("unconfirmed");
		expect(h.applyPoll.mock.calls.length).toBeGreaterThan(1);
	});
	it("stops a non-terminal apply after 45 minutes without failing it", async () => {
		await beginApply();
		h.applyPoll.mockResolvedValue({ status: "applying" });
		await tick(2702000);
		expect(h.proposal.applyResult?.status).toBe("unconfirmed");
	});
	it("shows a server apply failure promptly", async () => {
		await beginApply();
		h.applyPoll.mockResolvedValue({
			status: "failed",
			message: "Example terminal failure",
		});
		await tick(2000);
		expect(h.proposal.applyResult).toMatchObject({
			status: "failed",
			message: "Example terminal failure",
		});
	});
	it("reaches review after six minutes of analysis and shows the slow hint", async () => {
		const began = Date.now();
		h.poll.mockImplementation(async () =>
			Date.now() - began >= 360000
				? { progress: { status: "complete" }, proposal }
				: {
						progress: {
							status: "analyzing",
							message: "Reading example context",
						},
					},
		);
		mountChat();
		entry("analyze_backlog");
		await tick(300000);
		expect(screen.getByText(/taking longer than usual/)).toHaveTextContent(
			"Reading example context",
		);
		await tick(70000);
		expect(screen.getByTestId("review")).toBeInTheDocument();
	});
	it("recovers analysis from a hung read followed by completion", async () => {
		h.poll
			.mockImplementationOnce(() => new Promise(() => {}))
			.mockRejectedValueOnce(
				Object.assign(new Error("Restarting"), { code: "NOT_FOUND" }),
			)
			.mockResolvedValue({ progress: { status: "complete" }, proposal });
		mountChat();
		entry("analyze_backlog");
		await tick(36000);
		expect(screen.getByTestId("review")).toBeInTheDocument();
	});
	it("reconciles a sustained analysis read outage to a terminal server failure", async () => {
		h.poll.mockRejectedValue(new Error("Unavailable"));
		mountChat();
		entry("analyze_backlog");
		await tick(124000);
		expect(screen.getByText(/may still be running/)).toBeInTheDocument();
		expect(screen.queryByText("Analysis Failed")).toBeNull();
		h.poll.mockResolvedValue({
			progress: { status: "failed", message: "Example terminal failure" },
		});
		fireEvent.click(screen.getByText("Check existing analysis"));
		await tick(0);
		expect(screen.getByText("Analysis Failed")).toBeInTheDocument();
		expect(
			screen.getByText("Example terminal failure"),
		).toBeInTheDocument();
		expect(h.start).toHaveBeenCalledTimes(1);
	});
	it("tolerates transient analysis reads and still fails promptly on server failure", async () => {
		h.poll
			.mockRejectedValueOnce(
				Object.assign(new Error("Restarting"), { code: "NOT_FOUND" }),
			)
			.mockResolvedValue({
				progress: {
					status: "failed",
					message: "Example analysis failure",
				},
			});
		mountChat();
		entry("analyze_backlog");
		await tick(4000);
		expect(screen.getByText("Analysis Failed")).toBeInTheDocument();
		expect(
			screen.getByText("Example analysis failure"),
		).toBeInTheDocument();
	});
});

it.each(["apply", "analysis"] as const)(
	"does not double the generic %s slow message",
	(operation) => {
		const message = workflowPollMessage(
			operation === "apply" ? "Applying..." : "Analyzing...",
			true,
			operation,
		);
		expect(message).toMatch(/^Still /);
		expect(message).not.toMatch(/Applying\.\.\.|Analyzing\.\.\./);
	},
);
