/**
 * Conversation lifecycle of the orchestrator chat (#2040).
 *
 * - The conversation exists before the first stream call, so the turn runs
 *   under its id: a runtime-authority approval binds to the conversation and
 *   the next turn does not ask again, and the drawer's Expand has a
 *   conversation to open mid-reply.
 * - A turn stays "in flight" for the host until its client-side save lands,
 *   so the drawer does not navigate away from an unsaved turn.
 * - The landing offers the last conversation with a Resume link, and a
 *   restored document chat reaches the new conversation's metadata.
 *
 * The stream and conversation hooks are mocked; everything the component
 * decides on its own runs for real.
 */

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

const conversationHook = vi.hoisted(() => ({
	createConversation: vi.fn(),
	saveExecution: vi.fn(),
}));

const orpc = vi.hoisted(() => ({
	attach: vi.fn(),
	get: vi.fn(),
	update: vi.fn(),
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

vi.mock("../../../hooks/useOrchestratorStream", () => ({
	useOrchestratorStream: () => streamState.current,
}));

vi.mock(
	"../../../hooks/useOrchestratorConversation",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../hooks/useOrchestratorConversation")
			>();
		return {
			...actual,
			useOrchestratorConversation: () => ({
				createConversation: conversationHook.createConversation,
				saveExecution: conversationHook.saveExecution,
				convertStepResults: () => [],
			}),
		};
	},
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { conversations: { attach: orpc.attach } },
		agents: { conversations: { get: orpc.get, update: orpc.update } },
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
		useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
		useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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
	calls.order = [];
	streamState.current = idleStream();
	conversationHook.createConversation.mockImplementation(async () => {
		calls.order.push("createConversation");
		return { id: "conv_new" };
	});
	conversationHook.saveExecution.mockResolvedValue(undefined);
	orpc.attach.mockImplementation(async () => {
		calls.order.push("attach");
	});
	orpc.get.mockResolvedValue({ messages: [] });
	orpc.update.mockResolvedValue({});
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

async function send(text: string) {
	fireEvent.change(screen.getByLabelText("Message"), {
		target: { value: text },
	});
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
	});
}

describe("FabricTemporalOrchestratorChat — conversation before the first stream call", () => {
	it("creates the conversation, then streams the turn under its id", async () => {
		const onConversationCreated = vi.fn();
		render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				attachedProjectId="project_1"
				onConversationCreated={onConversationCreated}
			/>,
		);

		await send("Summarize the backlog");

		// The project attaches before the stream too, or the route could not
		// adopt it from the conversation.
		expect(calls.order).toEqual([
			"createConversation",
			"attach",
			"sendMessage",
		]);
		const sendMessage = (
			streamState.current as { sendMessage: ReturnType<typeof vi.fn> }
		).sendMessage;
		const args = sendMessage.mock.calls[0];
		expect(args[0]).toBe("Summarize the backlog");
		expect(args[args.length - 1]).toEqual({ conversationId: "conv_new" });
		expect(onConversationCreated).toHaveBeenCalledWith("conv_new");

		// Titled from, and seeded with, the user's first message.
		expect(conversationHook.createConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				initialMessage: "Summarize the backlog",
				initialMessageId: expect.any(String),
			}),
		);
	});

	/**
	 * The page loads the new conversation mid-turn and reads its tool
	 * selection back; a record created without it would read as "none" and
	 * the turn's save would erase the user's choice.
	 */
	it("stores the chat-tools selection on the new conversation", async () => {
		render(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);
		fireEvent.click(screen.getByRole("button", { name: "pick chat tool" }));

		await send("Use the picked server");

		expect(conversationHook.createConversation).toHaveBeenCalledWith(
			expect.objectContaining({ selectedMcpConfigIds: ["mcp_1"] }),
		);
	});

	it("records a restored document chat on the new conversation", async () => {
		render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				documentChatId="doc_chat_1"
			/>,
		);

		await send("What do the uploaded files say?");

		expect(conversationHook.createConversation).toHaveBeenCalledWith(
			expect.objectContaining({ documentChatId: "doc_chat_1" }),
		);
	});

	it("still sends the turn when the conversation cannot be created", async () => {
		conversationHook.createConversation.mockRejectedValueOnce(
			new Error("offline"),
		);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		render(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);

		await send("Hello");

		const sendMessage = (
			streamState.current as { sendMessage: ReturnType<typeof vi.fn> }
		).sendMessage;
		expect(sendMessage).toHaveBeenCalledTimes(1);
		const args = sendMessage.mock.calls[0];
		expect(args[args.length - 1]).toBeUndefined();
	});

	it("does not create a conversation for an empty send", async () => {
		render(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);

		await send("   ");

		expect(conversationHook.createConversation).not.toHaveBeenCalled();
	});

	it("saves the first turn over the seeded question instead of repeating it", async () => {
		const { rerender } = render(
			<FabricTemporalOrchestratorChat reasoningMode="balanced" />,
		);
		await send("First question");
		const seededId =
			conversationHook.createConversation.mock.calls[0][0]
				.initialMessageId;
		// What the record holds by the time the turn lands: the seeded
		// question, plus anything the workflow appended mid-turn.
		orpc.get.mockResolvedValue({
			messages: [
				{ id: seededId, role: "user", content: "First question" },
				{ id: "sys_1", role: "system", content: "Operation result" },
			],
		});

		streamState.current = idleStream({
			isComplete: true,
			state: {
				...(idleStream().state as Record<string, unknown>),
				status: "completed",
				executionId: "exec_1",
				result: { response: "The answer" },
			},
		});
		rerender(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);

		await waitFor(() =>
			expect(conversationHook.saveExecution).toHaveBeenCalledTimes(1),
		);
		const saved = conversationHook.saveExecution.mock.calls[0][0];
		expect(saved.conversationId).toBe("conv_new");
		expect(
			saved.messages.map((m: { role: string; content: string }) => [
				m.role,
				m.content,
			]),
		).toEqual([
			["system", "Operation result"],
			["user", "First question"],
			["assistant", "The answer"],
		]);
	});
});

describe("FabricTemporalOrchestratorChat — turn in flight until it is saved", () => {
	it("reports the turn as in flight until the save lands", async () => {
		let finishSave: () => void = () => undefined;
		conversationHook.saveExecution.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishSave = resolve;
				}),
		);
		const onStreamingChange = vi.fn();
		const { rerender } = render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				onStreamingChange={onStreamingChange}
			/>,
		);
		await send("Question");

		streamState.current = idleStream({ isLoading: true });
		rerender(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				onStreamingChange={onStreamingChange}
			/>,
		);
		expect(onStreamingChange).toHaveBeenLastCalledWith(true);
		onStreamingChange.mockClear();

		// The stream has ended, but the turn only exists in this component
		// until its save resolves.
		streamState.current = idleStream({
			isComplete: true,
			state: {
				...(idleStream().state as Record<string, unknown>),
				status: "completed",
				executionId: "exec_1",
				result: { response: "Done" },
			},
		});
		rerender(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				onStreamingChange={onStreamingChange}
			/>,
		);
		await waitFor(() =>
			expect(conversationHook.saveExecution).toHaveBeenCalled(),
		);
		expect(onStreamingChange).not.toHaveBeenCalledWith(false);

		await act(async () => {
			finishSave();
		});
		expect(onStreamingChange).toHaveBeenLastCalledWith(false);
	});
});

describe("FabricTemporalOrchestratorChat — a conversation another surface is writing", () => {
	function conversation(executions: unknown[]) {
		return {
			id: "conv_drawer",
			messages: [
				{
					id: "m1",
					role: "user" as const,
					content: "Question from the drawer",
					timestamp: new Date().toISOString(),
				},
			],
			metadata: {
				mode: "orchestrator",
				executionMode: "balanced",
				executions,
			},
		};
	}

	/**
	 * Expanding the drawer mid-reply opens the conversation on the full page
	 * while the drawer is still writing its turn. The page first sees the
	 * question alone; when the drawer's save lands it must show the answer
	 * rather than keep the half-written snapshot it hydrated first.
	 */
	it("shows the answer once the other surface saves its turn", async () => {
		const { rerender } = render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_drawer"
				activeConversation={conversation([])}
			/>,
		);
		expect(
			await screen.findByText("Question from the drawer"),
		).toBeInTheDocument();

		rerender(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_drawer"
				activeConversation={conversation([
					{
						id: "exec_drawer",
						userMessage: "Question from the drawer",
						finalResponse: "Answer written by the drawer",
						stepResults: [
							{
								stepId: "s1",
								status: "complete",
								response: "Answer written by the drawer",
								toolCalls: [],
							},
						],
						startedAt: new Date().toISOString(),
					},
				])}
			/>,
		);

		expect(
			await screen.findByText("Answer written by the drawer"),
		).toBeInTheDocument();
	});

	it("does not rewrite the stored settings when nothing changed", async () => {
		render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_drawer"
				activeConversation={conversation([])}
			/>,
		);
		await screen.findByText("Question from the drawer");

		expect(orpc.update).not.toHaveBeenCalled();
	});
});

describe("FabricTemporalOrchestratorChat — landing", () => {
	it("offers the most recent conversation with a Resume link", () => {
		const onResumeConversation = vi.fn();
		render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				recentConversation={{
					id: "conv_recent",
					title: "Quarterly roadmap",
					updatedAt: new Date().toISOString(),
				}}
				onResumeConversation={onResumeConversation}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /Resume/ }));

		expect(screen.getByText("Quarterly roadmap")).toBeInTheDocument();
		expect(onResumeConversation).toHaveBeenCalledWith("conv_recent");
	});

	it("uses the compact empty state in the drawer, without the Resume link", () => {
		render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				compactMode
				recentConversation={{
					id: "conv_recent",
					title: "Quarterly roadmap",
					updatedAt: new Date().toISOString(),
				}}
				onResumeConversation={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "What can I help you with?" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
	});
});
