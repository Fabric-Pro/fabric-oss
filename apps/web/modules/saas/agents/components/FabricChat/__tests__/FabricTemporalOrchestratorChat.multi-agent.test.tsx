/**
 * The Orchestrator chat's multi-agent mode (`COPILOTKIT_MULTI_AGENT_CHAT`),
 * through the chat itself:
 *
 *   - two picks hand the chat's prepared send to every picked agent (one
 *     pick keeps the single-agent send), and the whole set is saved;
 *   - each agent's answer renders as Nexus renders it, one block per agent;
 *   - Stop (and Esc) stop every agent still answering: each shows Stopped,
 *     with one Nexus cancel event per agent;
 *   - reopening a conversation whose last turn went to several agents picks
 *     them again, and renders that turn per agent.
 *
 * The stream hook is mocked (its hand-off to the multi-agent send is tested
 * in `useOrchestratorRuntimeStream.test.ts`); the multi-agent turn is real,
 * over a faked runtime transport.
 */

import { type AGUIEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MultiAgentSendRun } from "../../../lib/orchestrator-stream-types";

const m = vi.hoisted(() => ({
	streamOptions: null as null | {
		multiAgentSend?: (run: MultiAgentSendRun) => Promise<void>;
	},
	stop: vi.fn(),
	saveSelection: vi.fn(async () => ({})),
	runs: [] as RunAgentInput[],
	respond: null as
		| null
		| ((
				input: RunAgentInput,
				emit: (event: AGUIEvent) => void,
				signal: AbortSignal,
		  ) => Promise<void>),
	cancelEvents: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../hooks/useOrchestratorChatStream", () => ({
	useOrchestratorChatStream: (options: typeof m.streamOptions) => {
		m.streamOptions = options;
		return {
			messages: [],
			isLoading: false,
			state: {
				status: "idle",
				executionId: null,
				plan: null,
				result: null,
				pendingApproval: null,
				pendingClarification: null,
				answeredClarifications: [],
				contextCompactions: [],
				limitSignals: [],
				handoffRecommended: null,
			},
			sendMessage: vi.fn(async () => null),
			attach: vi.fn(),
			sendApproval: vi.fn(),
			sendClarification: vi.fn(),
			sendFollowUp: vi.fn(),
			reset: vi.fn(),
			isRunning: false,
			isAwaitingApproval: false,
			isComplete: false,
			isFollowUpEnabled: false,
			currentPhase: "idle",
			progressMessage: "",
			currentStep: null,
			completedSteps: 0,
			totalSteps: 0,
			stepResults: [],
			streamingToolCalls: [],
			planningAudit: null,
			artifacts: [],
			partykitStepProgress: null,
			stop: m.stop,
			transport: "runtime",
		};
	},
}));

vi.mock("../../../lib/direct-runtime-transport", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../lib/direct-runtime-transport")
	>()),
	streamRuntime: async (args: {
		input: RunAgentInput;
		signal: AbortSignal;
		onEvent: (event: AGUIEvent) => void;
	}) => {
		m.runs.push(args.input);
		await m.respond?.(args.input, args.onEvent, args.signal);
	},
}));

vi.mock("../../../lib/cancel-telemetry", () => ({
	emitCancelEvent: (payload: Record<string, unknown>) =>
		m.cancelEvents.push(payload),
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { conversations: { attach: vi.fn() } },
		agents: {
			conversations: {
				list: vi.fn(async () => ({
					conversations: [],
					total: 0,
					hasMore: false,
				})),
				get: vi.fn(async () => ({ messages: [] })),
				create: vi.fn(),
				update: vi.fn(),
				updateSettings: vi.fn(async () => ({ id: "conv" })),
				saveTurn: vi.fn(),
				removeMessage: vi.fn(),
			},
		},
		users: {
			chatAgentSelection: {
				get: vi.fn(),
				set: m.saveSelection,
			},
		},
		ai: { documents: {} },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: new Proxy(
		{},
		{
			get: () =>
				new Proxy(
					{},
					{
						get: () => ({
							key: () => ["mock"],
							queryOptions: () => ({ queryKey: ["mock"] }),
							getProject: {
								queryOptions: () => ({ queryKey: ["mock"] }),
							},
						}),
					},
				),
		},
	),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-query")>();
	return {
		...actual,
		useQuery: () => ({ data: undefined, isLoading: false }),
	};
});

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", name: "Test User" } }),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { id: "org_1", slug: "example-org" },
		isOrganizationAdmin: false,
	}),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useChatScopedProject",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@saas/projects/components/excalidraw-auto-insert/useChatScopedProject")
		>()),
		useChatScopedProjectFromOrchestratorStream: () => ({
			projectId: null,
			organizationId: "org_1",
			lastUserPromptForMessage: () => null,
		}),
	}),
);

const ALPHA = { agentId: "model:alpha", name: "Alpha" };
const BETA = { agentId: "model:beta", name: "Beta" };

vi.mock("../shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("../shared")>()),
	ChatInput: ({
		isLoading,
		onStop,
		headerSlot,
	}: {
		isLoading?: boolean;
		onStop?: () => void;
		headerSlot?: ReactNode;
	}) => (
		<div>
			{headerSlot}
			{isLoading ? (
				<button type="button" onClick={onStop}>
					Stop
				</button>
			) : null}
		</div>
	),
	ActiveContextIndicator: () => null,
	AgentModelPicker: ({
		selectedAgents,
		onToggleAgent,
	}: {
		selectedAgents: Array<{ agentId: string; name: string }>;
		onToggleAgent: (agent: { agentId: string; name: string }) => void;
	}) => (
		<div>
			<p data-testid="picked">
				{selectedAgents.map((agent) => agent.agentId).join(",")}
			</p>
			<button type="button" onClick={() => onToggleAgent(ALPHA)}>
				Pick Alpha
			</button>
			<button type="button" onClick={() => onToggleAgent(BETA)}>
				Pick Beta
			</button>
		</div>
	),
}));

vi.mock("../ConversationToolPicker", () => ({
	ConversationToolPicker: () => null,
}));

const { FabricTemporalOrchestratorChat } = await import(
	"../FabricTemporalOrchestratorChat"
);

const originalFetch = global.fetch;

beforeEach(() => {
	m.streamOptions = null;
	m.runs.length = 0;
	m.respond = null;
	m.cancelEvents.length = 0;
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	global.fetch = originalFetch;
	vi.clearAllMocks();
});

function renderChat(props: Record<string, unknown> = {}) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<FabricTemporalOrchestratorChat
				organizationId="org_1"
				reasoningMode="balanced"
				showAgentPicker
				multiAgentOffered
				{...props}
			/>
		</QueryClientProvider>,
	);
}

/**
 * Send through the chat's multi-agent hand-off (the chat's send prepares the
 * message, then hands it over). Resolves when the turn has started; the
 * returned promise settles when it is no longer followed.
 */
async function sendPrepared(forwardedProps: Record<string, unknown> = {}) {
	await waitFor(() =>
		expect(m.streamOptions?.multiAgentSend).toBeTypeOf("function"),
	);
	const send = m.streamOptions?.multiAgentSend;
	let sending: Promise<void> = Promise.resolve();
	await act(async () => {
		sending =
			send?.({
				threadId: "thread-1",
				content: "Compare the plans",
				history: [],
				forwardedProps,
				onRefused: () => undefined,
			}) ?? Promise.resolve();
		await Promise.resolve();
	});
	return { sending };
}

function pickBoth() {
	fireEvent.click(screen.getByRole("button", { name: "Pick Alpha" }));
	fireEvent.click(screen.getByRole("button", { name: "Pick Beta" }));
}

/** Both agents' text, as the runtime attributes it. */
function answer(
	runId: string,
	emit: (event: AGUIEvent) => void,
	texts: [string, string],
) {
	emit({ type: EventType.RUN_STARTED, threadId: "thread-1", runId });
	texts.forEach((delta, index) => {
		const memberKey = index === 0 ? runId : `${runId}_a${index}`;
		emit({
			type: EventType.TEXT_MESSAGE_START,
			messageId: `${memberKey}:text:1:n`,
			role: "assistant",
			subagentRunId: memberKey,
		});
		emit({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: `${memberKey}:text:1:n`,
			delta,
			subagentRunId: memberKey,
		});
	});
}

describe("FabricTemporalOrchestratorChat — a message to several agents", () => {
	it("sends to every picked agent once two are picked, saves the set, and shows each answer", async () => {
		m.respond = async (input, emit) => {
			answer(input.runId, emit, ["Plan A", "Plan B"]);
			for (const memberKey of [input.runId, `${input.runId}_a1`]) {
				emit({
					type: EventType.SUBAGENT_FINISHED,
					subagentRunId: memberKey,
					result: { status: "completed" },
					outcome: { type: "success" },
				});
			}
			emit({
				type: EventType.RUN_FINISHED,
				threadId: "thread-1",
				runId: input.runId,
				outcome: { type: "success" },
			});
		};
		renderChat();

		fireEvent.click(screen.getByRole("button", { name: "Pick Alpha" }));
		await waitFor(() =>
			expect(screen.getByTestId("picked").textContent).toBe(
				"model:alpha",
			),
		);
		expect(m.streamOptions?.multiAgentSend).toBeUndefined();

		fireEvent.click(screen.getByRole("button", { name: "Pick Beta" }));
		const { sending } = await sendPrepared({
			enabledFabricToolIds: ["web_search"],
		});
		await act(async () => {
			await sending;
		});

		expect(screen.getByTestId("picked").textContent).toBe(
			"model:alpha,model:beta",
		);
		expect(m.saveSelection).toHaveBeenLastCalledWith(
			expect.objectContaining({
				organizationId: "org_1",
				selectedAgents: [
					expect.objectContaining({ agentId: "model:alpha" }),
					expect.objectContaining({ agentId: "model:beta" }),
				],
			}),
		);
		expect(m.runs[0]?.forwardedProps).toMatchObject({
			enabledFabricToolIds: ["web_search"],
			multiAgent: {
				agents: [{ agentId: "model:alpha" }, { agentId: "model:beta" }],
			},
		});
		await waitFor(() => {
			expect(screen.getByText("Plan A")).toBeTruthy();
			expect(screen.getByText("Plan B")).toBeTruthy();
		});
		expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Beta").length).toBeGreaterThan(0);
	});

	it("stops every agent still answering, each Stopped, with one Nexus cancel event per agent", async () => {
		const stopCalls: string[] = [];
		global.fetch = vi.fn(async (url: RequestInfo | URL) => {
			stopCalls.push(String(url));
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		m.respond = async (input, emit, signal) => {
			answer(input.runId, emit, ["Partial A", "Partial B"]);
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve()),
			);
		};
		renderChat();
		pickBoth();
		await sendPrepared();

		await waitFor(() => screen.getByRole("button", { name: "Stop" }));
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));

		await waitFor(() =>
			expect(screen.getAllByText("Stopped")).toHaveLength(2),
		);
		expect(m.cancelEvents).toEqual([
			expect.objectContaining({
				surface: "nexus",
				agentId: "model:alpha",
				triggered_by: "button",
			}),
			expect.objectContaining({
				surface: "nexus",
				agentId: "model:beta",
				triggered_by: "button",
			}),
		]);
		expect(m.stop).not.toHaveBeenCalled();
		await waitFor(() => expect(stopCalls).toHaveLength(1));
		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
	});

	it("stops the agents on Esc too", async () => {
		global.fetch = vi.fn(
			async () => new Response(null, { status: 200 }),
		) as typeof fetch;
		m.respond = async (input, emit, signal) => {
			answer(input.runId, emit, ["Partial A", "Partial B"]);
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve()),
			);
		};
		renderChat();
		pickBoth();
		await sendPrepared();
		await waitFor(() => screen.getByRole("button", { name: "Stop" }));

		fireEvent.keyDown(document, { key: "Escape" });

		await waitFor(() => expect(m.cancelEvents).toHaveLength(2));
		expect(m.cancelEvents.map((event) => event.triggered_by)).toEqual([
			"esc",
			"esc",
		]);
	});

	it("makes the next pick first when the first is removed, and saves that", async () => {
		renderChat();
		pickBoth();
		await waitFor(() =>
			expect(screen.getByTestId("picked").textContent).toBe(
				"model:alpha,model:beta",
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "Pick Alpha" }));

		await waitFor(() =>
			expect(screen.getByTestId("picked").textContent).toBe("model:beta"),
		);
		expect(m.streamOptions?.multiAgentSend).toBeUndefined();
		expect(m.saveSelection).toHaveBeenLastCalledWith(
			expect.objectContaining({
				selectedAgents: [
					expect.objectContaining({ agentId: "model:beta" }),
				],
			}),
		);
	});

	it("picks the agents of a reopened conversation's multi-agent turn again, and shows its answers", async () => {
		const executionId = "orch-ma_saved-0001";
		renderChat({
			activeConversationId: "conv_saved",
			activeConversation: {
				id: "conv_saved",
				messages: [],
				metadata: {
					mode: "orchestrator",
					executions: [
						{
							id: executionId,
							userMessage: "Compare the plans",
							status: "completed",
							multiAgent: {
								version: 1,
								final: true,
								agents: [
									{
										index: 0,
										agentId: "model:alpha",
										name: "Alpha",
										memberKey: "ma_saved-0001",
										executionId,
										turnId: "turn-0",
										status: "complete",
										answer: "Saved plan A",
									},
									{
										index: 1,
										agentId: "model:beta",
										name: "Beta",
										memberKey: "ma_saved-0001_a1",
										executionId: "orch-ma_saved-0001_a1",
										turnId: "turn-1",
										status: "complete",
										answer: "Saved plan B",
									},
								],
							},
						},
					],
				},
			},
		});

		await waitFor(() =>
			expect(screen.getByTestId("picked").textContent).toBe(
				"model:alpha,model:beta",
			),
		);
		expect(screen.getByText("Saved plan A")).toBeTruthy();
		expect(screen.getByText("Saved plan B")).toBeTruthy();
		expect(m.streamOptions?.multiAgentSend).toBeTypeOf("function");
	});
});
