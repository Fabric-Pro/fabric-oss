/**
 * The orchestrator chat over the agent runtime (`COPILOTKIT_ORCHESTRATOR_CHAT`
 * on): the runtime creates the conversation with the first turn and saves
 * every turn into it, so the chat creates nothing up front, adopts the
 * conversation the run reports, and saves no turn itself. The stream hook is
 * mocked as running on the runtime; the conversation hook is real, so a save
 * would reach the oRPC client.
 */

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

const orpc = vi.hoisted(() => ({
	attach: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	updateSettings: vi.fn(),
	saveTurn: vi.fn(),
	removeMessage: vi.fn(),
}));

const streamState = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));

/** The options the chat passed to the stream hook. */
const streamOptions = vi.hoisted(() => ({
	current: null as null | {
		onConversationStarted?: (conversationId: string) => void;
		conversationSettings?: Record<string, unknown>;
	},
}));

function idleStream(overrides: Record<string, unknown> = {}) {
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
		stop: vi.fn(),
		transport: "runtime",
		...overrides,
	};
}

vi.mock("../../../hooks/useOrchestratorChatStream", () => ({
	useOrchestratorChatStream: (options: typeof streamOptions.current) => {
		streamOptions.current = options;
		return streamState.current;
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { conversations: { attach: orpc.attach } },
		agents: {
			conversations: {
				list: orpc.list,
				get: orpc.get,
				create: orpc.create,
				update: orpc.update,
				updateSettings: orpc.updateSettings,
				saveTurn: orpc.saveTurn,
				removeMessage: orpc.removeMessage,
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
	useSession: () => ({ user: { name: "Test User", image: null } }),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: null,
		isOrganizationAdmin: false,
	}),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useChatScopedProject",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@saas/projects/components/excalidraw-auto-insert/useChatScopedProject")
			>();
		return {
			...actual,
			useChatScopedProjectFromOrchestratorStream: () => null,
		};
	},
);

vi.mock("../shared", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../shared")>();
	return {
		...actual,
		ChatInput: ({
			value,
			onChange,
			onSend,
		}: {
			value: string;
			onChange: (value: string) => void;
			onSend: () => void;
		}) => (
			<div>
				<textarea
					aria-label="Message"
					value={value}
					onChange={(event) => onChange(event.target.value)}
				/>
				<button type="button" onClick={onSend}>
					Send
				</button>
			</div>
		),
		ActiveContextIndicator: () => null,
	};
});

vi.mock("../ConversationToolPicker", () => ({
	ConversationToolPicker: () => null,
}));

const { FabricTemporalOrchestratorChat } = await import(
	"../FabricTemporalOrchestratorChat"
);

beforeEach(() => {
	streamState.current = idleStream();
	streamOptions.current = null;
	orpc.attach.mockResolvedValue({});
	orpc.list.mockResolvedValue({
		conversations: [],
		total: 0,
		hasMore: false,
	});
	orpc.get.mockResolvedValue({ messages: [] });
	orpc.create.mockResolvedValue({ id: "conv_client" });
	orpc.saveTurn.mockResolvedValue({ id: "conv_client" });
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderChat(ui: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
	return {
		...view,
		rerender: (next: ReactNode) =>
			view.rerender(
				<QueryClientProvider client={client}>
					{next}
				</QueryClientProvider>,
			),
	};
}

async function send(text: string) {
	fireEvent.change(screen.getByLabelText("Message"), {
		target: { value: text },
	});
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
	});
}

describe("FabricTemporalOrchestratorChat — over the agent runtime", () => {
	it("creates no conversation up front, and adopts the one the run reports", async () => {
		const onConversationCreated = vi.fn();
		renderChat(
			<FabricTemporalOrchestratorChat
				organizationId="org_1"
				reasoningMode="balanced"
				onConversationCreated={onConversationCreated}
			/>,
		);

		await send("What changed this week?");

		const sendMessage = (
			streamState.current as { sendMessage: ReturnType<typeof vi.fn> }
		).sendMessage;
		expect(sendMessage).toHaveBeenCalledTimes(1);
		// No conversation is named: the runtime mints the thread.
		expect(sendMessage.mock.calls[0]?.at(-1)).toBeUndefined();
		expect(orpc.create).not.toHaveBeenCalled();
		expect(streamOptions.current?.conversationSettings).toMatchObject({
			executionMode: "balanced",
		});

		await act(async () => {
			streamOptions.current?.onConversationStarted?.("conv_runtime");
		});

		await waitFor(() =>
			expect(onConversationCreated).toHaveBeenCalledWith("conv_runtime"),
		);
	});

	it("saves no turn itself when a turn ends, and reports the conversation saved", async () => {
		const onConversationSaved = vi.fn();
		const { rerender } = renderChat(
			<FabricTemporalOrchestratorChat
				organizationId="org_1"
				reasoningMode="balanced"
				onConversationSaved={onConversationSaved}
			/>,
		);
		await send("What changed this week?");

		streamState.current = idleStream({
			isComplete: true,
			state: {
				...(idleStream().state as Record<string, unknown>),
				status: "completed",
				executionId: "orch-exec-1",
				result: { response: "Three merges." },
			},
		});
		rerender(
			<FabricTemporalOrchestratorChat
				organizationId="org_1"
				reasoningMode="balanced"
				onConversationSaved={onConversationSaved}
			/>,
		);

		await waitFor(() => expect(onConversationSaved).toHaveBeenCalled());
		expect(orpc.saveTurn).not.toHaveBeenCalled();
		expect(orpc.create).not.toHaveBeenCalled();
	});
});
