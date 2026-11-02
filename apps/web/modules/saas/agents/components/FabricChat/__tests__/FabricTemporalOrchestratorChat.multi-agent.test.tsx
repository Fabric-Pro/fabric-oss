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
	within,
} from "@testing-library/react";
import {
	type ComponentProps,
	type ReactNode,
	startTransition,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
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
	attach: vi.fn(),
	savedSelection: undefined as
		| undefined
		| {
				selectedAgents: Array<{ agentId: string; name: string }>;
				defaultAgent: null;
		  },
	/** The chat's model listing (the picker's and the answered-by label's). */
	modelListing: undefined as
		| undefined
		| {
				models: Array<{ canonicalName: string; displayName: string }>;
				chatgptPlan?: { source: "own" | "shared"; models: [] };
		  },
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
			attach: m.attach,
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
		// The member's saved picks, once a test has them arrive.
		useQuery: (options: { queryKey: unknown[] }) => {
			const data =
				options.queryKey[0] === "chat-agent-selection"
					? m.savedSelection
					: options.queryKey[0] === "ai-models-available"
						? m.modelListing
						: undefined;
			return { data, isLoading: false, isSuccess: data !== undefined };
		},
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
	useTranslations: () => (key: string, values?: { model?: string }) =>
		values?.model ? `${key}: ${values.model}` : key,
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

/** The model a member's completion names (`AnswerModelInfo`). */
interface ServedModel {
	id: string;
	canonicalName?: string;
	provider?: string;
	viaPlan: boolean;
}
/** The organization's shared ChatGPT plan answered the Alpha pick. */
const SERVED_BY_PLAN: ServedModel = {
	id: "gpt-plan-example",
	canonicalName: "gpt-plan-example",
	provider: "OPENAI_CHATGPT_PLAN",
	viaPlan: true,
};
const SERVED_AS_PICKED: ServedModel = {
	id: "beta",
	canonicalName: "beta",
	provider: "OPENAI",
	viaPlan: false,
};
const SHARED_PLAN_LISTING = {
	models: [
		{ canonicalName: "alpha", displayName: "Alpha Model" },
		{ canonicalName: "beta", displayName: "Beta Model" },
	],
	chatgptPlan: { source: "shared" as const, models: [] as [] },
};

/** The answer block an agent's answer renders in. */
function answerBlock(text: string): HTMLElement {
	const block = screen.getByText(text).closest<HTMLElement>(".group");
	if (!block) {
		throw new Error(`No answer block holds "${text}"`);
	}
	return block;
}

/**
 * The Alpha block names the plan's model (not in the listing, so its id) and
 * says its pick was not applied, with the pick-status note; the Beta block
 * names its own model, by the listing's name, and nothing more.
 */
function expectServedLabels(alphaText: string, betaText: string) {
	const alpha = within(answerBlock(alphaText));
	expect(alpha.getAllByText(/^answeredByModel: /)).toEqual([
		alpha.getByText("answeredByModel: gpt-plan-example"),
	]);
	expect(alpha.getByText("not applied").getAttribute("title")).toMatch(
		/shared ChatGPT plan is on/,
	);
	const beta = within(answerBlock(betaText));
	expect(beta.getAllByText(/^answeredByModel: /)).toEqual([
		beta.getByText("answeredByModel: Beta Model"),
	]);
	expect(beta.queryByText("not applied")).toBeNull();
}

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
	m.savedSelection = undefined;
	m.modelListing = undefined;
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	global.fetch = originalFetch;
	vi.clearAllMocks();
});

const queryClient = new QueryClient({
	defaultOptions: { mutations: { retry: false } },
});

function chatElement(props: Record<string, unknown>) {
	return (
		<QueryClientProvider client={queryClient}>
			<FabricTemporalOrchestratorChat
				organizationId="org_1"
				reasoningMode="balanced"
				showAgentPicker
				multiAgentOffered
				{...props}
			/>
		</QueryClientProvider>
	);
}

function renderChat(props: Record<string, unknown> = {}) {
	queryClient.clear();
	return render(chatElement(props));
}

/**
 * A conversation whose last turn went to Alpha and Beta: as saved when the
 * turn ended, or as the admission saved it while both still answer (a
 * reload mid-turn reads that).
 */
function savedConversation(
	stage: "final" | "running",
	served: [ServedModel?, ServedModel?] = [],
) {
	const executionId = "orch-ma_saved-0001";
	const final = stage === "final";
	const agent = (index: number, name: string, answerText: string) => ({
		index,
		agentId: `model:${name.toLowerCase()}`,
		name,
		memberKey: index === 0 ? "ma_saved-0001" : `ma_saved-0001_a${index}`,
		executionId: index === 0 ? executionId : `${executionId}_a${index}`,
		turnId: `turn-${index}`,
		status: final ? "complete" : "running",
		...(final ? { answer: answerText } : {}),
		...(served[index] ? { record: { model: served[index] } } : {}),
	});
	return {
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
						status: final ? "completed" : "running",
						startedAt: "2026-10-30T10:00:00.000Z",
						...(final
							? { completedAt: "2026-10-30T10:01:00.000Z" }
							: { inProgress: true }),
						multiAgent: {
							version: 1,
							final,
							agents: [
								agent(0, "Alpha", "Saved plan A"),
								agent(1, "Beta", "Saved plan B"),
							],
						},
					},
				],
			},
		},
	};
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

type PageConversation = ComponentProps<
	typeof FabricTemporalOrchestratorChat
>["activeConversation"];

/**
 * The Fabric AI page's hold on the chat's conversation, as `FabricAIClient`
 * keeps it: a created conversation goes into the URL (a navigation, so a
 * transition), the URL selects it, its stored copy is read, and a selected
 * conversation that reads as gone clears the URL again. Fails the test past
 * a render budget: a conversation adopted before it is saved reads as gone,
 * and the selection then swings between it and none while the URL lags.
 */
function AdoptingPage({
	isSaved,
	onAdoptedUnsaved,
}: {
	isSaved: (id: string) => boolean;
	onAdoptedUnsaved: (id: string) => void;
}) {
	const [url, setUrl] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [read, setRead] = useState<{
		id: string;
		conversation: PageConversation;
	} | null>(null);
	const renders = useRef(0);
	renders.current += 1;
	if (renders.current > 400) {
		throw new Error("The page re-rendered without end");
	}
	const navigate = useCallback((id: string | null) => {
		startTransition(() => setUrl(id));
	}, []);
	useEffect(() => {
		if (!selected) {
			return;
		}
		const conversation = isSaved(selected)
			? { id: selected, messages: [], metadata: { mode: "orchestrator" } }
			: null;
		if (!conversation) {
			onAdoptedUnsaved(selected);
		}
		setRead({ id: selected, conversation });
	}, [selected, isSaved, onAdoptedUnsaved]);
	useEffect(() => {
		if (url && url !== selected) {
			setSelected(url);
		} else if (!url && selected) {
			setSelected(null);
		}
	}, [url, selected]);
	const conversation =
		read && read.id === selected ? read.conversation : undefined;
	useEffect(() => {
		if (url && selected === url && conversation === null) {
			navigate(null);
			setSelected(null);
		}
	}, [url, selected, conversation, navigate]);
	return (
		<>
			<p data-testid="page-conversation">{selected ?? ""}</p>
			<FabricTemporalOrchestratorChat
				organizationId="org_1"
				reasoningMode="balanced"
				showAgentPicker
				multiAgentOffered
				activeConversationId={selected}
				activeConversation={conversation}
				onConversationCreated={navigate}
			/>
		</>
	);
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

	it("adopts a new chat's conversation only once the run has started it, so the page does not loop on a conversation not yet saved", async () => {
		const saved = new Set<string>();
		const adoptedBeforeSaved: string[] = [];
		m.respond = async (input, emit) => {
			// The server saves the conversation a moment after the request.
			await new Promise((resolve) => setTimeout(resolve, 50));
			saved.add(input.threadId);
			answer(input.runId, emit, ["Plan A", "Plan B"]);
			emit({
				type: EventType.RUN_FINISHED,
				threadId: input.threadId,
				runId: input.runId,
				outcome: { type: "success" },
			});
		};
		render(
			<QueryClientProvider client={new QueryClient()}>
				<AdoptingPage
					isSaved={(id) => saved.has(id)}
					onAdoptedUnsaved={(id) => adoptedBeforeSaved.push(id)}
				/>
			</QueryClientProvider>,
		);
		pickBoth();
		const { sending } = await sendPrepared();
		await act(async () => {
			await sending;
		});

		expect(adoptedBeforeSaved).toEqual([]);
		await waitFor(() => {
			expect(screen.getByText("Plan A")).toBeTruthy();
			expect(screen.getByText("Plan B")).toBeTruthy();
		});
		expect(screen.getByTestId("page-conversation").textContent).toBe(
			"thread-1",
		);
	});

	it("picks the agents of a reopened conversation's multi-agent turn again, and shows its answers", async () => {
		renderChat(savedConversation("final"));

		await waitFor(() =>
			expect(screen.getByTestId("picked").textContent).toBe(
				"model:alpha,model:beta",
			),
		);
		expect(screen.getByText("Saved plan A")).toBeTruthy();
		expect(screen.getByText("Saved plan B")).toBeTruthy();
		expect(m.streamOptions?.multiAgentSend).toBeTypeOf("function");
	});

	it("names the model that answered each agent, and says when a model pick was not applied", async () => {
		m.modelListing = SHARED_PLAN_LISTING;
		m.respond = async (input, emit) => {
			answer(input.runId, emit, ["Plan A", "Plan B"]);
			const ends: Array<[string, string, ServedModel]> = [
				[input.runId, "Plan A", SERVED_BY_PLAN],
				[`${input.runId}_a1`, "Plan B", SERVED_AS_PICKED],
			];
			for (const [memberKey, response, model] of ends) {
				emit({
					type: EventType.SUBAGENT_FINISHED,
					subagentRunId: memberKey,
					result: { status: "completed", response, model },
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
		pickBoth();
		const { sending } = await sendPrepared();
		await act(async () => {
			await sending;
		});

		await waitFor(() => expectServedLabels("Plan A", "Plan B"));
	});

	it("keeps each agent's answered-by label and not-applied note when the turn is reopened", async () => {
		m.modelListing = SHARED_PLAN_LISTING;
		renderChat(
			savedConversation("final", [SERVED_BY_PLAN, SERVED_AS_PICKED]),
		);

		await waitFor(() => expectServedLabels("Saved plan A", "Saved plan B"));
	});

	it("keeps the reopened turn's picks when the member's saved picks arrive after them", async () => {
		const props = savedConversation("final");
		const { rerender } = renderChat(props);
		await waitFor(() =>
			expect(screen.getByTestId("picked").textContent).toBe(
				"model:alpha,model:beta",
			),
		);

		// A model kept in this chat only is never saved: the store has the first.
		m.savedSelection = { selectedAgents: [ALPHA], defaultAgent: null };
		rerender(chatElement(props));

		await waitFor(() =>
			expect(screen.getByTestId("picked").textContent).toBe(
				"model:alpha,model:beta",
			),
		);
	});

	it("picks the member's saved agents in a chat with no multi-agent turn to reopen", async () => {
		m.savedSelection = {
			selectedAgents: [ALPHA, BETA],
			defaultAgent: null,
		};
		renderChat();

		await waitFor(() =>
			expect(screen.getByTestId("picked").textContent).toBe(
				"model:alpha,model:beta",
			),
		);
	});

	it("follows a turn still running at reload as the agents' turn only, never as a single agent's", async () => {
		m.respond = async (input, emit) => {
			answer("ma_saved-0001", emit, ["Live plan A", "Live plan B"]);
			emit({
				type: EventType.RUN_FINISHED,
				threadId: input.threadId,
				runId: "ma_saved-0001",
				outcome: { type: "success" },
			});
		};
		renderChat(savedConversation("running"));

		await waitFor(() => {
			expect(screen.getByText("Live plan A")).toBeTruthy();
			expect(screen.getByText("Live plan B")).toBeTruthy();
		});
		expect(m.runs[0]?.threadId).toBe("conv_saved");
		expect(m.attach).not.toHaveBeenCalled();
		expect(screen.getAllByText("Compare the plans")).toHaveLength(1);
		expect(screen.getByTestId("picked").textContent).toBe(
			"model:alpha,model:beta",
		);
	});
});
