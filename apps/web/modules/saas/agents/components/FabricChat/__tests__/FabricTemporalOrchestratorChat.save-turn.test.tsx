/**
 * The orchestrator chat's turn save through the real conversation hook
 * (Fizzy #2949). Only the oRPC client, the stream hook and heavy children are
 * mocked; `useOrchestratorConversation` and its mutations run for real.
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

const calls = vi.hoisted(() => ({ order: [] as string[] }));

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
		sendMessage: vi.fn(async () => {
			calls.order.push("sendMessage");
			return null;
		}),
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
		...overrides,
	};
}

// The options the chat passed to the hook, so a test can drive the
// callbacks the real hook would call.
const streamOptions = vi.hoisted(() => ({
	current: null as null | {
		onTurnRefused?: (content: string) => string | undefined;
	},
}));

vi.mock("../../../hooks/useOrchestratorStream", () => ({
	useOrchestratorStream: (options: {
		onTurnRefused?: (content: string) => string | undefined;
	}) => {
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
		// Queries are stubbed; mutations are real, so the conversation hook's
		// save runs as it does in the app and reaches the oRPC client.
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

// Image shaping draws on a canvas, which jsdom lacks; the file passes as is.
vi.mock("@saas/projects/lib/image-upload-utils", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@saas/projects/lib/image-upload-utils")
		>();
	return {
		...actual,
		prepareImageForAi: async (file: File) => ({ ok: true, file }),
	};
});

// The composer's own behaviour is covered elsewhere; here it only has to
// carry text in and a send out.
vi.mock("../shared", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../shared")>();
	return {
		...actual,
		ChatInput: ({
			value,
			onChange,
			onSend,
			headerSlot,
		}: {
			value: string;
			onChange: (value: string) => void;
			onSend: () => void;
			headerSlot?: ReactNode;
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
				{headerSlot}
			</div>
		),
		ActiveContextIndicator: () => null,
	};
});

// Stands in for the Chat-tools dialog: one click picks one server.
vi.mock("../ConversationToolPicker", () => ({
	ConversationToolPicker: ({
		onChange,
	}: {
		onChange: (ids: string[]) => void;
	}) => (
		<button type="button" onClick={() => onChange(["mcp_1"])}>
			pick chat tool
		</button>
	),
}));

const { FabricTemporalOrchestratorChat } = await import(
	"../FabricTemporalOrchestratorChat"
);

beforeEach(() => {
	streamState.current = idleStream();
	orpc.attach.mockResolvedValue({});
	orpc.list.mockResolvedValue({
		conversations: [],
		total: 0,
		hasMore: false,
	});
	orpc.get.mockResolvedValue({ messages: [] });
	orpc.update.mockResolvedValue({});
	orpc.updateSettings.mockResolvedValue({ id: "conv" });
	orpc.removeMessage.mockResolvedValue({ removed: true });
	orpc.saveTurn.mockResolvedValue({
		id: "conv_late",
		addedMessages: 1,
		removedMessages: 0,
	});
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

/**
 * Fizzy #2949: when the conversation cannot be created before the turn runs,
 * the turn is admitted with no conversation and the chat creates one when
 * the turn ends. That save goes through the real conversation hook here (only
 * the oRPC client is mocked), so the request the server receives is the one
 * pinned: the conversation is created holding the question under the id the
 * turn's save sends, and the save names the turn's execution id, which the
 * server associates with the new conversation.
 */
describe("FabricTemporalOrchestratorChat — a turn whose conversation is created when it ends", () => {
	it("creates the conversation, then saves only the turn under the execution id", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		orpc.create
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ id: "conv_late" });
		const { rerender } = renderChat(
			<FabricTemporalOrchestratorChat
				organizationId="org_1"
				reasoningMode="balanced"
			/>,
		);

		await send("What changed this week?");
		// The turn was sent with no conversation.
		const sendMessage = (
			streamState.current as { sendMessage: ReturnType<typeof vi.fn> }
		).sendMessage;
		expect(sendMessage.mock.calls[0]?.at(-1)).toBeUndefined();

		streamState.current = idleStream({
			isComplete: true,
			state: {
				...(idleStream().state as Record<string, unknown>),
				status: "completed",
				executionId: "orch-exec-late",
				result: { response: "Three merges." },
			},
		});
		rerender(
			<FabricTemporalOrchestratorChat
				organizationId="org_1"
				reasoningMode="balanced"
			/>,
		);

		await waitFor(() => expect(orpc.saveTurn).toHaveBeenCalledTimes(1));
		expect(orpc.create).toHaveBeenCalledTimes(2);
		const created = orpc.create.mock.calls[1]?.[0] as {
			organizationId: string;
			messages: Array<{ id: string; role: string; content: string }>;
		};
		const saved = orpc.saveTurn.mock.calls[0]?.[0] as {
			conversationId: string;
			organizationId: string;
			execution: { id: string };
			messages: Array<{ id: string; role: string; content: string }>;
			removeMessageIds?: string[];
			settings: Record<string, unknown>;
		};

		expect(created.organizationId).toBe("org_1");
		expect(created.messages).toHaveLength(1);
		expect(saved.conversationId).toBe("conv_late");
		expect(saved.organizationId).toBe("org_1");
		expect(saved.execution.id).toBe("orch-exec-late");
		expect(saved.messages.map((m) => [m.role, m.content])).toEqual([
			["user", "What changed this week?"],
			["assistant", "Three merges."],
		]);
		// Seeded under the same id, so the server keeps one copy.
		expect(saved.messages[0]?.id).toBe(created.messages[0]?.id);
		expect(saved.removeMessageIds).toBeUndefined();
		expect(saved.settings).toMatchObject({ executionMode: "balanced" });
		// Nothing read back and rewritten.
		expect(orpc.get).not.toHaveBeenCalled();
		expect(orpc.update).not.toHaveBeenCalled();
	});
});
