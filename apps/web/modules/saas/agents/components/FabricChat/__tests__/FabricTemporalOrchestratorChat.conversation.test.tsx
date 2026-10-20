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
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { hydrateConversationTurnResults } from "../../../../../../../../packages/database/prisma/queries/conversation-turn-results";
import { APPROVAL_STALE_MESSAGE } from "../../../lib/approval-response";

// The read projection is real; this integration test needs no database client.
vi.mock("../../../../../../../../packages/database/prisma/client", () => ({
	db: {},
}));

const calls = vi.hoisted(() => ({ order: [] as string[] }));

const conversationHook = vi.hoisted(() => ({
	createConversation: vi.fn(),
	saveExecution: vi.fn(),
}));

const orpc = vi.hoisted(() => ({
	attach: vi.fn(),
	get: vi.fn(),
	update: vi.fn(),
	updateSettings: vi.fn(),
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
		attach: vi.fn(async () => null),
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
		agents: {
			conversations: {
				get: orpc.get,
				update: orpc.update,
				updateSettings: orpc.updateSettings,
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
	orpc.updateSettings.mockResolvedValue({ id: "conv" });
	orpc.removeMessage.mockResolvedValue({ removed: true });
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

describe("FabricTemporalOrchestratorChat — stale approval notice", () => {
	it.each(["Approve", "Decline", "Provide Feedback"])(
		"shows the stale notice after %s instead of reporting success",
		async (action) => {
			const notify = vi
				.spyOn(toast, "info")
				.mockImplementation(() => "notice");
			const success = vi
				.spyOn(toast, "success")
				.mockImplementation(() => "notice");
			const sendApproval = vi.fn().mockResolvedValue("stale");
			streamState.current = idleStream({
				messages: [
					{
						id: "message-example",
						role: "user",
						content: "Run the workflow",
					},
				],
				isAwaitingApproval: true,
				sendApproval,
				state: {
					...idleStream().state,
					status: "awaiting_approval",
					pendingApproval: {
						approvalId: "approval-example",
						stepId: "step-example",
						reason: "HIGH RISK: Allow the workflow to run?",
					},
				},
			});
			try {
				render(
					<FabricTemporalOrchestratorChat reasoningMode="balanced" />,
				);
				fireEvent.click(
					screen.getByRole("button", { name: action, exact: true }),
				);
				if (action === "Provide Feedback") {
					fireEvent.change(
						screen.getByPlaceholderText(
							"Provide feedback or alternative instructions...",
						),
						{
							target: { value: "Use the newer decision" },
						},
					);
					fireEvent.click(
						screen.getByRole("button", {
							name: "Send Feedback",
							exact: true,
						}),
					);
				}
				await waitFor(() =>
					expect(notify).toHaveBeenCalledWith(APPROVAL_STALE_MESSAGE),
				);
				expect(sendApproval).toHaveBeenCalledTimes(1);
				expect(success).not.toHaveBeenCalled();
			} finally {
				notify.mockRestore();
				success.mockRestore();
			}
		},
	);
});

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
		// Only this turn is sent; the server takes the seeded copy out in the
		// same locked write, keeping whatever the workflow appended mid-turn.
		expect(
			saved.messages.map((m: { role: string; content: string }) => [
				m.role,
				m.content,
			]),
		).toEqual([
			["user", "First question"],
			["assistant", "The answer"],
		]);
		expect(saved.removeMessageIds).toEqual([seededId]);
		// A fresh id: the server keeps a stored message whose id it is sent
		// again, so the seeded id would keep the seed and drop this copy.
		expect(saved.messages[0].id).not.toBe(seededId);
	});

	/**
	 * Fizzy #2949: the save used to read the conversation and write the
	 * whole message list back, so a turn another tab saved between that read
	 * and the write was lost. The chat now sends only its own turn and never
	 * reads the conversation to build the save.
	 */
	it("sends only its own turn, never the conversation it read, so another tab's turn is kept", async () => {
		const { rerender } = render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_existing"
			/>,
		);
		await send("My question");
		// What the record holds when this turn lands: a turn another tab
		// saved meanwhile.
		orpc.get.mockResolvedValue({
			messages: [
				{
					id: "other_q",
					role: "user",
					content: "Other tab's question",
				},
				{
					id: "other_a",
					role: "assistant",
					content: "Other tab's answer",
				},
			],
		});

		streamState.current = idleStream({
			isComplete: true,
			state: {
				...(idleStream().state as Record<string, unknown>),
				status: "completed",
				executionId: "exec_mine",
				result: { response: "My answer" },
			},
		});
		rerender(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_existing"
			/>,
		);

		await waitFor(() =>
			expect(conversationHook.saveExecution).toHaveBeenCalledTimes(1),
		);
		const saved = conversationHook.saveExecution.mock.calls[0][0];
		expect(saved.conversationId).toBe("conv_existing");
		expect(saved.execution.id).toBe("exec_mine");
		expect(
			saved.messages.map((m: { role: string; content: string }) => [
				m.role,
				m.content,
			]),
		).toEqual([
			["user", "My question"],
			["assistant", "My answer"],
		]);
		expect(saved.removeMessageIds).toEqual([]);
		expect(orpc.get).not.toHaveBeenCalled();
		expect(orpc.update).not.toHaveBeenCalled();
	});

	it("creates the conversation with the turn's question id when it could not be created up front", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		conversationHook.createConversation.mockRejectedValueOnce(
			new Error("offline"),
		);
		const { rerender } = render(
			<FabricTemporalOrchestratorChat reasoningMode="balanced" />,
		);
		await send("Hello");

		streamState.current = idleStream({
			isComplete: true,
			state: {
				...(idleStream().state as Record<string, unknown>),
				status: "completed",
				executionId: "exec_1",
				result: { response: "Hi" },
			},
		});
		rerender(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);

		await waitFor(() =>
			expect(conversationHook.saveExecution).toHaveBeenCalledTimes(1),
		);
		expect(conversationHook.createConversation).toHaveBeenCalledTimes(2);
		const created = conversationHook.createConversation.mock.calls[1][0];
		const saved = conversationHook.saveExecution.mock.calls[0][0];
		// The conversation is created holding the question under the id the
		// save sends it with, so the server finds it stored and does not add
		// a second copy.
		expect(created.initialMessage).toBe("Hello");
		expect(created.initialMessageId).toBe(saved.messages[0].id);
		expect(saved.messages[0]).toMatchObject({
			role: "user",
			content: "Hello",
		});
		expect(saved.removeMessageIds).toBeUndefined();
	});
});

// A different message is already being answered in this conversation
// (another tab): the server refuses this one with TURN_IN_PROGRESS. The hook
// removes the question and its placeholder, leaves no executionId, and sets
// the notice in `state.result.error` (its own tests cover that); this checks
// what the chat does with that state.
describe("FabricTemporalOrchestratorChat — a message refused because another is being answered", () => {
	const NOTICE =
		"Your message was not sent: another message in this conversation is already being answered, possibly in another tab. Send yours when that answer finishes.";

	// What the hook's state is after a refusal: the chat's `onTurnRefused`
	// may return a sentence, which the hook appends to its notice.
	function refusedStream(addition?: string) {
		return idleStream({
			messages: [],
			isComplete: true,
			state: {
				...(idleStream().state as Record<string, unknown>),
				status: "failed",
				executionId: null,
				result: { error: addition ? `${NOTICE} ${addition}` : NOTICE },
			},
		});
	}

	/** Refuses the first send the way the hook does; later sends succeed. */
	function refusingFirstSend() {
		let sends = 0;
		const sendMessage = vi.fn(async (content: string) => {
			sends++;
			if (sends === 1) {
				const addition =
					streamOptions.current?.onTurnRefused?.(content);
				streamState.current = {
					...refusedStream(addition),
					sendMessage,
				};
			}
			return null;
		});
		return sendMessage;
	}

	it("shows the notice, never shows or saves the message, and puts its text back in the composer", async () => {
		streamState.current = idleStream({
			sendMessage: vi.fn(async (content: string) => {
				streamState.current = refusedStream();
				streamOptions.current?.onTurnRefused?.(content);
				return null;
			}),
		});
		render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_existing"
			/>,
		);

		await send("Review the last commits");

		expect(screen.getByTestId("failed-turn").textContent).toContain(
			"already being answered",
		);
		// Back in the composer, and nowhere else on the page.
		const composer = screen.getByLabelText(
			"Message",
		) as HTMLTextAreaElement;
		expect(composer.value).toBe("Review the last commits");
		expect(
			screen
				.queryAllByText("Review the last commits")
				.filter((el) => el !== composer),
		).toEqual([]);
		// Nothing reaches the conversation record.
		await act(async () => {
			await Promise.resolve();
		});
		expect(conversationHook.saveExecution).not.toHaveBeenCalled();
		expect(conversationHook.createConversation).not.toHaveBeenCalled();
		// The conversation already existed, so this send saved nothing in it
		// and has nothing to take back out.
		expect(orpc.removeMessage).not.toHaveBeenCalled();
	});

	describe("a refused message that carried attachments", () => {
		const ATTACH_AGAIN = /attachments were not sent.*attach them again/i;
		const readyDocument = {
			id: "file_1",
			file: new File(["notes"], "notes.txt", { type: "text/plain" }),
			name: "notes.txt",
			type: "text/plain",
			size: 5,
			documentId: "doc_example_1",
			status: "ready" as const,
			contextEntry: "<attachment notes.txt>",
		};
		const originalFetch = global.fetch;
		const originalCreate = URL.createObjectURL;
		const originalRevoke = URL.revokeObjectURL;
		beforeEach(() => {
			global.fetch = vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({
					url: "https://example.com/signed/photo.png",
					storagePath: "uploads/example-org/photo.png",
				}),
			})) as unknown as typeof fetch;
			URL.createObjectURL = vi.fn(() => "blob:example-preview");
			URL.revokeObjectURL = vi.fn();
		});
		afterEach(() => {
			global.fetch = originalFetch;
			URL.createObjectURL = originalCreate;
			URL.revokeObjectURL = originalRevoke;
		});

		it("says an image was not sent and has to be attached again", async () => {
			const sendMessage = refusingFirstSend();
			streamState.current = idleStream({ sendMessage });
			const { container } = render(
				<FabricTemporalOrchestratorChat
					reasoningMode="balanced"
					activeConversationId="conv_existing"
				/>,
			);
			await act(async () => {
				fireEvent.change(
					container.querySelector(
						'input[type="file"]',
					) as HTMLInputElement,
					{
						target: {
							files: [
								new File(["png"], "photo.png", {
									type: "image/png",
								}),
							],
						},
					},
				);
			});

			await send("What is in this picture?");

			expect((sendMessage.mock.calls[0] as unknown[])[7]).toEqual([
				"uploads/example-org/photo.png",
			]);
			expect(screen.getByTestId("failed-turn").textContent).toMatch(
				ATTACH_AGAIN,
			);
			expect(
				(screen.getByLabelText("Message") as HTMLTextAreaElement).value,
			).toBe("What is in this picture?");
		});

		it("says a document was not sent and has to be attached again", async () => {
			const sendMessage = refusingFirstSend();
			streamState.current = idleStream({ sendMessage });
			render(
				<FabricTemporalOrchestratorChat
					reasoningMode="balanced"
					activeConversationId="conv_existing"
					initialAttachedDocuments={[readyDocument]}
				/>,
			);

			await send("Summarize this file");

			expect((sendMessage.mock.calls[0] as unknown[])[9]).toEqual([
				"doc_example_1",
			]);
			expect(screen.getByTestId("failed-turn").textContent).toMatch(
				ATTACH_AGAIN,
			);
		});

		it("says nothing about attachments for a text-only message", async () => {
			const sendMessage = refusingFirstSend();
			streamState.current = idleStream({ sendMessage });
			render(
				<FabricTemporalOrchestratorChat
					reasoningMode="balanced"
					activeConversationId="conv_existing"
				/>,
			);

			await send("Review the last commits");

			const notice = screen.getByTestId("failed-turn").textContent;
			expect(notice).toContain("already being answered");
			expect(notice).not.toMatch(/attach/i);
		});

		it("does not carry the attachment note over to a later text-only refusal", async () => {
			let sends = 0;
			const sendMessage = vi.fn(async (content: string) => {
				sends++;
				const addition =
					streamOptions.current?.onTurnRefused?.(content);
				streamState.current = {
					...refusedStream(addition),
					sendMessage,
				};
				return null;
			});
			streamState.current = idleStream({ sendMessage });
			render(
				<FabricTemporalOrchestratorChat
					reasoningMode="balanced"
					activeConversationId="conv_existing"
					initialAttachedDocuments={[readyDocument]}
				/>,
			);

			await send("Summarize this file");
			expect(screen.getByTestId("failed-turn").textContent).toMatch(
				ATTACH_AGAIN,
			);
			// The text came back; the document did not. Sent again as is.
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Send" }));
			});
			expect(sends).toBe(2);
			expect((sendMessage.mock.calls[1] as unknown[])[9]).toBeUndefined();
			expect(screen.getByTestId("failed-turn").textContent).not.toMatch(
				/attach/i,
			);
		});
	});

	it("a successful send after a refusal clears the notice, and its turn is saved", async () => {
		let sends = 0;
		const sendMessage = vi.fn(async (content: string) => {
			sends++;
			if (sends === 1) {
				streamState.current = { ...refusedStream(), sendMessage };
				streamOptions.current?.onTurnRefused?.(content);
			} else {
				streamState.current = idleStream({
					sendMessage,
					isLoading: true,
					isRunning: true,
					state: {
						...(idleStream().state as Record<string, unknown>),
						status: "running",
					},
				});
			}
			return null;
		});
		streamState.current = idleStream({ sendMessage });
		orpc.get.mockResolvedValue({ messages: [] });
		const { rerender } = render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_existing"
			/>,
		);

		await send("Review the last commits");
		expect(screen.getByTestId("failed-turn")).toBeTruthy();

		// Sent again once the other answer finished.
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Send" }));
		});
		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(screen.queryByTestId("failed-turn")).toBeNull();

		streamState.current = idleStream({
			sendMessage,
			isComplete: true,
			state: {
				...(idleStream().state as Record<string, unknown>),
				status: "completed",
				executionId: "exec_2",
				result: { response: "The review" },
			},
		});
		rerender(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_existing"
			/>,
		);

		expect(screen.queryByTestId("failed-turn")).toBeNull();
		await waitFor(() =>
			expect(conversationHook.saveExecution).toHaveBeenCalledTimes(1),
		);
		const saved = conversationHook.saveExecution.mock.calls[0][0];
		expect(saved.conversationId).toBe("conv_existing");
		expect(saved.execution.id).toBe("exec_2");
		expect(
			saved.messages.map((m: { role: string; content: string }) => [
				m.role,
				m.content,
			]),
		).toEqual([
			["user", "Review the last commits"],
			["assistant", "The review"],
		]);
	});

	it("does not overwrite a draft typed while the refused message was in flight", async () => {
		streamState.current = idleStream({
			sendMessage: vi.fn(async (content: string) => {
				fireEvent.change(screen.getByLabelText("Message"), {
					target: { value: "a new draft" },
				});
				streamState.current = refusedStream();
				streamOptions.current?.onTurnRefused?.(content);
				return null;
			}),
		});
		render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_existing"
			/>,
		);

		await send("Review the last commits");

		expect(
			(screen.getByLabelText("Message") as HTMLTextAreaElement).value,
		).toBe("a new draft");
		expect(screen.getByTestId("failed-turn")).toBeTruthy();
	});

	// A new chat is created holding its first question before the turn is
	// admitted (#2040). Refused, that question was never answered and must
	// not stay in the saved conversation (Fizzy #2958).
	describe("the first message of a new chat", () => {
		it("is taken back out of the conversation it was saved in", async () => {
			const sendMessage = refusingFirstSend();
			streamState.current = idleStream({ sendMessage });
			render(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);

			await send("Review the last commits");

			const seededId =
				conversationHook.createConversation.mock.calls[0][0]
					.initialMessageId;
			expect(seededId).toEqual(expect.any(String));
			expect(sendMessage.mock.calls[0].at(-1)).toEqual({
				conversationId: "conv_new",
			});
			expect(orpc.removeMessage).toHaveBeenCalledTimes(1);
			expect(orpc.removeMessage).toHaveBeenCalledWith({
				conversationId: "conv_new",
				messageId: seededId,
				organizationId: undefined,
			});
			// Never an explicit null: the server refuses a request that names
			// no organization.
			expect(orpc.removeMessage.mock.calls[0][0].organizationId).not.toBe(
				null,
			);
			expect(screen.getByTestId("failed-turn").textContent).toContain(
				"already being answered",
			);
		});

		/**
		 * Refuses the first send the way the hook does, lets the user send
		 * again (the same text, or `resendText`), completes that turn, and
		 * returns what the chat saved for it. `stored` is what the
		 * conversation record holds when the resend's turn is saved.
		 */
		async function resendAfterRefusal(
			stored: (seededId: string) => unknown[],
			resendText?: string,
		) {
			let sends = 0;
			const sendMessage = vi.fn(async (content: string) => {
				sends++;
				if (sends === 1) {
					streamState.current = { ...refusedStream(), sendMessage };
					streamOptions.current?.onTurnRefused?.(content);
				}
				return null;
			});
			streamState.current = idleStream({ sendMessage });
			const { rerender } = render(
				<FabricTemporalOrchestratorChat reasoningMode="balanced" />,
			);

			await send("Review the last commits");
			const seededId: string =
				conversationHook.createConversation.mock.calls[0][0]
					.initialMessageId;
			await act(async () => {
				await Promise.resolve();
			});
			orpc.get.mockResolvedValue({ messages: stored(seededId) });
			if (resendText !== undefined) {
				fireEvent.change(screen.getByLabelText("Message"), {
					target: { value: resendText },
				});
			}
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Send" }));
			});
			expect(sendMessage).toHaveBeenCalledTimes(2);
			// The resend runs in the conversation already created.
			expect(conversationHook.createConversation).toHaveBeenCalledTimes(
				1,
			);

			streamState.current = idleStream({
				sendMessage,
				isComplete: true,
				state: {
					...(idleStream().state as Record<string, unknown>),
					status: "completed",
					executionId: "exec_2",
					result: { response: "The review" },
				},
			});
			rerender(
				<FabricTemporalOrchestratorChat reasoningMode="balanced" />,
			);

			await waitFor(() =>
				expect(conversationHook.saveExecution).toHaveBeenCalledTimes(1),
			);
			const saved = conversationHook.saveExecution.mock.calls[0][0];
			expect(saved.conversationId).toBe("conv_new");
			return {
				seededId,
				removeMessageIds: saved.removeMessageIds as string[],
				messages: saved.messages as Array<{
					id: string;
					role: string;
					content: string;
				}>,
			};
		}

		it("is saved exactly once when sent again after the removal succeeded", async () => {
			const { seededId, messages } = await resendAfterRefusal(() => []);

			expect(orpc.removeMessage).toHaveBeenCalledTimes(1);
			expect(messages.map((m) => [m.role, m.content])).toEqual([
				["user", "Review the last commits"],
				["assistant", "The review"],
			]);
			// Never under the seed's id: a removal still in flight deletes
			// only that id, and must not reach the new question.
			expect(messages[0]?.id).not.toBe(seededId);
		});

		it("is saved exactly once when sent again after the removal failed", async () => {
			orpc.removeMessage.mockRejectedValue(new Error("offline"));
			vi.spyOn(console, "warn").mockImplementation(() => undefined);

			// The seed survived the failed removal.
			const { seededId, removeMessageIds, messages } =
				await resendAfterRefusal((id) => [
					{
						id,
						role: "user",
						content: "Review the last commits",
					},
				]);

			expect(orpc.removeMessage).toHaveBeenCalledTimes(2);
			// The surviving seed is dropped in the same write, and the
			// question saved once, under a new id.
			expect(removeMessageIds).toEqual([seededId]);
			expect(messages.map((m) => [m.role, m.content])).toEqual([
				["user", "Review the last commits"],
				["assistant", "The review"],
			]);
			expect(messages[0]?.id).not.toBe(seededId);
		});

		it("is removed late without touching a newer question saved in the meantime", async () => {
			// The first removal hangs (its commit's response is lost, or it
			// is just slow) and only fails after the user has sent another
			// question and that turn has been saved; then the retry runs.
			let failFirstRemoval: (error: Error) => void = () => undefined;
			orpc.removeMessage
				.mockImplementationOnce(
					() =>
						new Promise((_resolve, reject) => {
							failFirstRemoval = reject;
						}),
				)
				.mockResolvedValueOnce({ removed: true });

			const { seededId, messages } = await resendAfterRefusal(
				() => [],
				"Something else entirely",
			);
			expect(messages.map((m) => [m.role, m.content])).toEqual([
				["user", "Something else entirely"],
				["assistant", "The review"],
			]);
			expect(orpc.removeMessage).toHaveBeenCalledTimes(1);

			await act(async () => {
				failFirstRemoval(new Error("response lost"));
				await Promise.resolve();
			});
			await waitFor(() =>
				expect(orpc.removeMessage).toHaveBeenCalledTimes(2),
			);

			// Every removal names the seed, and the saved question is not
			// the seed, so neither the late attempt nor the retry can delete
			// it.
			const removedIds = orpc.removeMessage.mock.calls.map(
				(call) => (call[0] as { messageId: string }).messageId,
			);
			expect(removedIds).toEqual([seededId, seededId]);
			expect(messages[0]?.id).not.toBe(seededId);
		});

		it("retries a failed removal once", async () => {
			orpc.removeMessage
				.mockRejectedValueOnce(new Error("offline"))
				.mockResolvedValueOnce({ removed: true });
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			const sendMessage = refusingFirstSend();
			streamState.current = idleStream({ sendMessage });
			render(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);

			await send("Review the last commits");
			await act(async () => {
				await Promise.resolve();
			});

			expect(orpc.removeMessage).toHaveBeenCalledTimes(2);
			expect(orpc.removeMessage.mock.calls[1][0]).toEqual(
				orpc.removeMessage.mock.calls[0][0],
			);
			expect(warn).not.toHaveBeenCalled();
		});

		it("still shows the notice when the removal fails twice", async () => {
			orpc.removeMessage.mockRejectedValue(new Error("offline"));
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			const sendMessage = refusingFirstSend();
			streamState.current = idleStream({ sendMessage });
			render(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);

			await send("Review the last commits");
			await act(async () => {
				await Promise.resolve();
			});

			expect(orpc.removeMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("failed-turn").textContent).toContain(
				"already being answered",
			);
			expect(
				(screen.getByLabelText("Message") as HTMLTextAreaElement).value,
			).toBe("Review the last commits");
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("refused first message"),
				expect.any(Error),
			);
		});

		it("is not removed by a later refusal after its own turn's save failed", async () => {
			vi.spyOn(console, "error").mockImplementation(() => undefined);
			let sends = 0;
			const sendMessage = vi.fn(async (content: string) => {
				sends++;
				if (sends === 2) {
					streamState.current = { ...refusedStream(), sendMessage };
					streamOptions.current?.onTurnRefused?.(content);
				}
				return null;
			});
			streamState.current = idleStream({ sendMessage });
			const { rerender } = render(
				<FabricTemporalOrchestratorChat reasoningMode="balanced" />,
			);

			// The first turn runs and answers, but its save fails, so the
			// chat still holds the id of the question it was created with.
			await send("First question");
			conversationHook.saveExecution.mockRejectedValueOnce(
				new Error("save failed"),
			);
			streamState.current = idleStream({
				sendMessage,
				isComplete: true,
				state: {
					...(idleStream().state as Record<string, unknown>),
					status: "completed",
					executionId: "exec_1",
					result: { response: "The answer" },
				},
			});
			rerender(
				<FabricTemporalOrchestratorChat reasoningMode="balanced" />,
			);
			await waitFor(() =>
				expect(conversationHook.saveExecution).toHaveBeenCalledTimes(1),
			);

			// The next message is refused. It did not create the
			// conversation, so the first question, which was answered, stays.
			await send("Second question");
			expect(sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("failed-turn")).toBeTruthy();
			expect(conversationHook.createConversation).toHaveBeenCalledTimes(
				1,
			);
			expect(orpc.removeMessage).not.toHaveBeenCalled();
		});
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
	it.each([
		["CANCELLED", "cancelled", "Stopped"],
		["FAILED", "error", "Execution failed"],
	] as const)(
		"keeps a reconciled %s partial answer in the transcript and followup history",
		async (terminalStatus, status, caption) => {
			const timestamp = new Date("2026-10-01T10:01:00.000Z");
			const projected = hydrateConversationTurnResults(
				{
					messages: [
						{
							id: "saved-partial-answer",
							role: "assistant",
							content: "The saved partial finding",
							timestamp: timestamp.toISOString(),
							metadata: { executionId: "exec_partial" },
						},
					],
					metadata: {
						mode: "orchestrator",
						executions: [
							{
								id: "exec_partial",
								userMessage: "Question from the drawer",
								status,
								finalResponse: "The saved partial finding",
								completedAt: timestamp.toISOString(),
							},
						],
					},
				},
				[
					{
						id: "turn_partial",
						executionId: "exec_partial",
						generation: 1,
						status: terminalStatus,
						questionText: null,
						responseText: null,
						terminalAt: timestamp,
						createdAt: timestamp,
						terminalReason: "reconciled: workflow stopped",
						limitSignalSummary: null,
					},
				],
			);
			render(
				<FabricTemporalOrchestratorChat
					reasoningMode="balanced"
					activeConversationId="conv_partial"
					activeConversation={{ id: "conv_partial", ...projected }}
				/>,
			);
			expect(
				await screen.findByText("The saved partial finding"),
			).toBeInTheDocument();
			expect(screen.getByText(caption)).toBeInTheDocument();
			await send("Continue from the partial finding");
			const sendMessage = streamState.current.sendMessage as ReturnType<
				typeof vi.fn
			>;
			expect(sendMessage.mock.calls[0][1]).toEqual([
				{ role: "user", content: "Question from the drawer" },
				{ role: "assistant", content: "The saved partial finding" },
			]);
			expect(conversationHook.saveExecution).not.toHaveBeenCalled();
		},
	);

	it.each([
		[
			"FAILED",
			null,
			"Partial generated answer",
			"The workflow may still be running.",
		],
		[
			"CANCELLED",
			"",
			"Partial generated answer",
			"The workflow may still be running.",
		],
		[
			"LIMITED",
			null,
			"Partial generated answer",
			"The workflow may still be running.",
		],
		[
			"COMPLETED",
			"Durable completed answer",
			"Partial generated answer",
			"The workflow may still be running.",
		],
		["FAILED", null, "Identical answer", "Identical answer"],
		["FAILED", null, undefined, "Execution-only answer"],
		["FAILED", null, "Message-only answer", undefined],
	] as const)(
		"preserves distinct saved responses through projection, reopening and followup (%s, %s, %s, %s)",
		async (status, responseText, messageText, executionText) => {
			const timestamp = new Date("2026-10-01T10:01:00.000Z");
			const source = {
				messages: [
					{
						id: "question",
						role: "user",
						content: "Question from the drawer",
						timestamp: timestamp.toISOString(),
						metadata: { executionId: "exec_saved" },
					},
					...(messageText
						? [
								{
									id: "answer",
									role: "assistant",
									content: messageText,
									timestamp: timestamp.toISOString(),
									metadata: { executionId: "exec_saved" },
								},
							]
						: []),
				],
				metadata: {
					mode: "orchestrator",
					executions: executionText
						? [
								{
									id: "exec_saved",
									userMessage: "Question from the drawer",
									status: "error",
									finalResponse: executionText,
								},
							]
						: [],
				},
			};
			const turns = [
				{
					id: "turn_saved",
					executionId: "exec_saved",
					generation: 1,
					status,
					responseText,
					terminalAt: timestamp,
					createdAt: timestamp,
					terminalReason: "reconciled: workflow timed_out",
					limitSignalSummary: null,
				},
			];
			const projected = hydrateConversationTurnResults(source, turns);
			expect(hydrateConversationTurnResults(projected, turns)).toEqual(
				projected,
			);
			render(
				<FabricTemporalOrchestratorChat
					reasoningMode="balanced"
					activeConversationId="conv_saved"
					activeConversation={{ id: "conv_saved", ...projected }}
				/>,
			);
			const primary = responseText || executionText || messageText;
			const responses = [
				...new Set(
					[primary, executionText, messageText].filter(
						(value): value is NonNullable<typeof value> =>
							typeof value === "string" && value.length > 0,
					),
				),
			];
			for (const response of responses) {
				expect(await screen.findAllByText(response)).toHaveLength(1);
			}
			if (status === "FAILED") {
				expect(
					screen.getByText("Execution failed"),
				).toBeInTheDocument();
			}
			if (status !== "COMPLETED") {
				expect(
					screen.getByText("reconciled: workflow timed_out"),
				).toBeInTheDocument();
			}
			await send("Continue from the saved answer");
			const sendMessage = streamState.current.sendMessage as ReturnType<
				typeof vi.fn
			>;
			expect(sendMessage.mock.calls[0][1]).toEqual([
				{ role: "user", content: "Question from the drawer" },
				...responses.map((content) => ({ role: "assistant", content })),
			]);
			expect(conversationHook.saveExecution).not.toHaveBeenCalled();
		},
	);

	it("refreshes newly available distinct saved content at the same execution count while idle", async () => {
		const timestamp = new Date("2026-10-01T10:01:00.000Z");
		const source = {
			messages: [
				{
					id: "question",
					role: "user",
					content: "Saved question",
					timestamp: timestamp.toISOString(),
					metadata: { executionId: "exec_saved" },
				},
			],
			metadata: {
				mode: "orchestrator",
				executions: [
					{
						id: "exec_saved",
						userMessage: "Saved question",
						status: "complete",
						finalResponse: "Durable answer",
					},
				],
			},
		};
		const turns = [
			{
				id: "turn_saved",
				executionId: "exec_saved",
				generation: 1,
				status: "COMPLETED" as const,
				questionText: null,
				responseText: "Durable answer",
				terminalAt: timestamp,
				createdAt: timestamp,
				terminalReason: "completed",
				limitSignalSummary: null,
			},
		];
		const before = hydrateConversationTurnResults(source, turns);
		const { rerender } = render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_saved"
				activeConversation={{ id: "conv_saved", ...before }}
			/>,
		);
		expect(await screen.findByText("Durable answer")).toBeInTheDocument();
		const after = hydrateConversationTurnResults(
			{
				...source,
				messages: [
					...source.messages,
					{
						id: "partial",
						role: "assistant",
						content: "Independent saved detail",
						timestamp: timestamp.toISOString(),
						metadata: { executionId: "exec_saved" },
					},
				],
			},
			turns,
		);
		rerender(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_saved"
				activeConversation={{ id: "conv_saved", ...after }}
			/>,
		);
		expect(
			await screen.findByText("Independent saved detail"),
		).toBeInTheDocument();
		await send("Continue with the saved detail");
		const sendMessage = streamState.current.sendMessage as ReturnType<
			typeof vi.fn
		>;
		expect(sendMessage.mock.calls[0][1]).toEqual([
			{ role: "user", content: "Saved question" },
			{ role: "assistant", content: "Durable answer" },
			{ role: "assistant", content: "Independent saved detail" },
		]);
	});

	it("attaches to a turn still running, then shows its answer once it finishes", async () => {
		const timestamp = new Date("2026-10-01T10:01:00.000Z");
		const source = { messages: [], metadata: { mode: "orchestrator" } };
		const running = {
			id: "turn_running",
			executionId: "exec_running",
			generation: 2,
			status: "ACTIVE" as const,
			questionText: "Make me a weekly status page",
			responseText: null,
			terminalAt: null,
			createdAt: timestamp,
			terminalReason: null,
			limitSignalSummary: null,
		};
		const before = hydrateConversationTurnResults(source, [running]);
		const { rerender } = render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_running"
				activeConversation={{ id: "conv_running", ...before }}
			/>,
		);
		// The live view takes the turn over (its stream is mocked here).
		const attach = streamState.current.attach as ReturnType<typeof vi.fn>;
		await waitFor(() => {
			expect(attach).toHaveBeenCalledWith(
				"exec_running",
				"Make me a weekly status page",
				"conv_running",
			);
		});
		expect(attach).toHaveBeenCalledTimes(1);

		const after = hydrateConversationTurnResults(source, [
			{
				...running,
				status: "COMPLETED",
				responseText: "Created the weekly workflow.",
				terminalAt: timestamp,
				terminalReason: "completed",
			},
		]);
		rerender(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_running"
				activeConversation={{ id: "conv_running", ...after }}
			/>,
		);
		expect(
			await screen.findByText("Created the weekly workflow."),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				"Still running when this conversation was opened",
			),
		).not.toBeInTheDocument();
		expect(
			screen.getAllByText("Make me a weekly status page"),
		).toHaveLength(1);
	});

	it("does not send a still-running turn's bare question as history", async () => {
		const timestamp = new Date("2026-10-01T10:01:00.000Z");
		const projected = hydrateConversationTurnResults(
			{
				messages: [],
				metadata: {
					mode: "orchestrator",
					executions: [
						{
							id: "exec_done",
							userMessage: "Earlier question",
							finalResponse: "Earlier answer",
							status: "complete",
						},
					],
				},
			},
			[
				{
					id: "turn_running",
					executionId: "exec_running",
					generation: 2,
					status: "ACTIVE",
					questionText: "Make me a weekly status page",
					responseText: null,
					terminalAt: null,
					createdAt: timestamp,
					terminalReason: null,
					limitSignalSummary: null,
				},
			],
		);
		render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_running_history"
				activeConversation={{
					id: "conv_running_history",
					...projected,
				}}
			/>,
		);
		expect(await screen.findByText("Earlier answer")).toBeInTheDocument();

		await send("Next question");

		const sendMessage = streamState.current.sendMessage as ReturnType<
			typeof vi.fn
		>;
		expect(sendMessage.mock.calls[0][1]).toEqual([
			{ role: "user", content: "Earlier question" },
			{ role: "assistant", content: "Earlier answer" },
		]);
	});

	it("shows the specific durable reason for an empty failed result", async () => {
		const timestamp = new Date("2026-10-01T10:01:00.000Z");
		const projected = hydrateConversationTurnResults(
			{ messages: [], metadata: { mode: "orchestrator" } },
			[
				{
					id: "turn_failed",
					executionId: "exec_failed",
					generation: 1,
					status: "FAILED",
					questionText: null,
					responseText: null,
					terminalAt: timestamp,
					createdAt: timestamp,
					terminalReason: "reconciled: workflow timed_out",
					limitSignalSummary: null,
				},
			],
		);
		render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_failed"
				activeConversation={{ id: "conv_failed", ...projected }}
			/>,
		);
		expect(await screen.findByText("Execution failed")).toBeInTheDocument();
		expect(
			screen.getByText("reconciled: workflow timed_out"),
		).toBeInTheDocument();
	});

	it("refreshes a browser transport notice into the durable result and uses the answer in followup history", async () => {
		const notice = "The workflow may still be running.";
		const record = {
			id: "exec_drawer",
			userMessage: "Question from the drawer",
			status: "error",
			finalResponse: notice,
			completedAt: "2026-10-01T10:01:00.000Z",
		};
		const { rerender } = render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_drawer"
				activeConversation={conversation([record])}
			/>,
		);
		expect(await screen.findByText(notice)).toBeInTheDocument();
		rerender(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_drawer"
				activeConversation={conversation([
					{
						...record,
						status: "complete",
						terminalStatus: "COMPLETED",
						recoveredFromTurn: true,
						finalResponse: "The durable completed answer",
					},
				])}
			/>,
		);
		expect(
			await screen.findByText("The durable completed answer"),
		).toBeInTheDocument();
		expect(screen.queryByText(notice)).not.toBeInTheDocument();
		await send("Continue from the completed answer");
		const sendMessage = streamState.current.sendMessage as ReturnType<
			typeof vi.fn
		>;
		expect(sendMessage.mock.calls[0][1]).toEqual([
			{ role: "user", content: "Question from the drawer" },
			{ role: "assistant", content: "The durable completed answer" },
		]);
	});

	it.each([
		["streaming", { isLoading: true, isRunning: true }],
		["awaiting approval", { isAwaitingApproval: true }],
	])(
		"defers a recovered refresh while %s and still excludes the current execution when idle",
		async (_label, flags) => {
			streamState.current = idleStream({
				...flags,
				state: { ...idleStream().state, executionId: "exec_live" },
			});
			const old = {
				id: "exec_old",
				userMessage: "Earlier question",
				recoveredFromTurn: true,
				finalResponse: "Earlier projection",
				completedAt: "2026-10-01T10:01:00.000Z",
			};
			const current = {
				...old,
				id: "exec_live",
				userMessage: "Live current question",
				finalResponse: "Live current response",
			};
			const { rerender } = render(
				<FabricTemporalOrchestratorChat
					reasoningMode="balanced"
					activeConversationId="conv_drawer"
					activeConversation={conversation([old, current])}
				/>,
			);
			expect(
				await screen.findByText("Earlier projection"),
			).toBeInTheDocument();
			const updated = conversation([
				{ ...old, finalResponse: "Updated durable response" },
				current,
			]);
			rerender(
				<FabricTemporalOrchestratorChat
					reasoningMode="balanced"
					activeConversationId="conv_drawer"
					activeConversation={updated}
				/>,
			);
			expect(
				screen.queryByText("Updated durable response"),
			).not.toBeInTheDocument();
			expect(
				screen.queryByText("Live current response"),
			).not.toBeInTheDocument();
			streamState.current = idleStream({
				state: { ...idleStream().state, executionId: "exec_live" },
			});
			rerender(
				<FabricTemporalOrchestratorChat
					reasoningMode="balanced"
					activeConversationId="conv_drawer"
					activeConversation={updated}
				/>,
			);
			expect(
				await screen.findByText("Updated durable response"),
			).toBeInTheDocument();
			expect(
				screen.queryByText("Live current response"),
			).not.toBeInTheDocument();
			await send("Follow up while idle");
			const sendMessage = streamState.current.sendMessage as ReturnType<
				typeof vi.fn
			>;
			expect(sendMessage.mock.calls[0][1]).toEqual([
				{ role: "user", content: "Earlier question" },
				{ role: "assistant", content: "Updated durable response" },
			]);
		},
	);

	it("replaces an idle recovered entry with richer saved details at the same execution count", async () => {
		const onActivityChange = vi.fn();
		const recovered = {
			id: "exec_drawer",
			userMessage: "Question from the drawer",
			finalResponse: "Earlier projection",
			recoveredFromTurn: true,
			terminalStatus: "COMPLETED",
			completedAt: "2026-10-01T10:01:00.000Z",
		};
		const { rerender } = render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_drawer"
				activeConversation={conversation([recovered])}
				onActivityChange={onActivityChange}
			/>,
		);
		expect(
			await screen.findByText("Earlier projection"),
		).toBeInTheDocument();
		const plan = {
			id: "plan-1",
			description: "Saved execution plan",
			riskLevel: "low",
			steps: [
				{
					id: "step-1",
					description: "Read saved details",
					status: "completed",
					order: 1,
				},
			],
		};
		const saved = {
			...recovered,
			recoveredFromTurn: false,
			finalResponse: "Browser saved answer",
			plan,
			stepResults: [
				{
					stepId: "step-1",
					stepDescription: "Read saved details",
					status: "complete",
					response: "Browser saved answer",
					toolCalls: [],
				},
			],
			artifacts: [
				{
					id: "artifact-1",
					type: "document",
					name: "Saved report",
					content: "Saved report content. ".repeat(10),
				},
			],
			clarifications: [
				{ question: "Which project?", answer: "The example project" },
			],
		};
		rerender(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_drawer"
				activeConversation={conversation([saved])}
				onActivityChange={onActivityChange}
			/>,
		);
		expect(
			await screen.findByText("Browser saved answer"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Earlier projection"),
		).not.toBeInTheDocument();
		expect(onActivityChange).toHaveBeenCalledWith(
			expect.objectContaining({ plan }),
		);
		fireEvent.click(screen.getByRole("button", { name: /Artifacts/ }));
		fireEvent.mouseDown(screen.getByRole("tab", { name: /Documents/ }), {
			button: 0,
			ctrlKey: false,
		});
		expect(await screen.findByText("Saved report")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		await send("Follow up on the report");
		const sendMessage = streamState.current.sendMessage as ReturnType<
			typeof vi.fn
		>;
		expect(sendMessage.mock.calls[0][1]).toEqual([
			{ role: "user", content: "Question from the drawer" },
			{
				role: "user",
				content: expect.stringContaining("The example project"),
			},
			{ role: "assistant", content: "Browser saved answer" },
		]);
	});

	it("shows an updated durable answer alongside retained partial steps and uses it in followup history", async () => {
		const recovered = {
			id: "exec_drawer",
			userMessage: "Question from the drawer",
			recoveredFromTurn: true,
			terminalStatus: "COMPLETED",
			finalResponse: "Authoritative durable answer",
			completedAt: "2026-10-01T10:01:00.000Z",
			stepResults: [
				{
					stepId: "partial-step",
					status: "complete",
					response: "Partial browser step",
					toolCalls: [],
				},
			],
		};
		render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_drawer"
				activeConversation={conversation([recovered])}
			/>,
		);
		expect(
			await screen.findByText("Authoritative durable answer"),
		).toBeInTheDocument();
		expect(screen.getByText("Partial browser step")).toBeInTheDocument();
		await send("Use the completed answer");
		const sendMessage = streamState.current.sendMessage as ReturnType<
			typeof vi.fn
		>;
		expect(sendMessage.mock.calls[0][1]).toEqual([
			{ role: "user", content: "Question from the drawer" },
			{ role: "assistant", content: "Authoritative durable answer" },
		]);
	});

	it.each([
		["CANCELLED", "Stopped"],
		["FAILED", "Execution failed"],
		["LIMITED", "Answer may be incomplete"],
	])(
		"shows a detached %s outcome when no response was produced",
		async (terminalStatus, caption) => {
			render(
				<FabricTemporalOrchestratorChat
					reasoningMode="balanced"
					activeConversationId="conv_empty_result"
					activeConversation={{
						id: "conv_empty_result",
						messages: [],
						metadata: {
							mode: "orchestrator",
							executions: [
								{
									id: "exec_empty",
									userMessage: "",
									recoveredFromTurn: true,
									terminalStatus,
									finalResponse: "",
									completedAt: "2026-10-01T10:01:00.000Z",
									limitSignals: [
										null,
										{ kind: "provider_quota", message: [] },
									],
								},
							],
						},
					}}
				/>,
			);
			expect(await screen.findByText(caption)).toBeInTheDocument();
			expect(conversationHook.saveExecution).not.toHaveBeenCalled();
		},
	);

	it.each([
		["COMPLETED", null],
		["CANCELLED", "Stopped"],
		["FAILED", "Execution failed"],
		["LIMITED", "Answer may be incomplete"],
	])(
		"shows a detached %s result without a saved question",
		async (terminalStatus, caption) => {
			const { container } = render(
				<FabricTemporalOrchestratorChat
					reasoningMode="balanced"
					activeConversationId="conv_detached"
					activeConversation={{
						id: "conv_detached",
						messages: [],
						metadata: {
							mode: "orchestrator",
							executions: [
								{
									id: "exec_detached",
									userMessage: "",
									recoveredFromTurn: true,
									finalResponse:
										"Answer produced after the tab closed",
									terminalStatus,
									completedAt: "2026-10-01T10:01:00.000Z",
									limitSignals:
										terminalStatus === "LIMITED"
											? [
													{
														kind: "provider_quota",
														message:
															"Provider quota reached",
													},
												]
											: [],
								},
							],
						},
					}}
				/>,
			);
			expect(
				await screen.findByText("Answer produced after the tab closed"),
			).toBeInTheDocument();
			if (caption) {
				const notice = screen.getByText(caption).closest("output");
				expect(notice).toBeInTheDocument();
				// jsdom cannot measure color contrast without a canvas implementation.
				expect(
					(
						await axe(notice as HTMLElement, {
							rules: { "color-contrast": { enabled: false } },
						})
					).violations,
				).toEqual([]);
			}
			if (terminalStatus === "LIMITED") {
				expect(
					screen.getByText("Provider quota reached"),
				).toBeInTheDocument();
			}
			expect(container.querySelector(".is-user")).toBeNull();
			expect(conversationHook.saveExecution).not.toHaveBeenCalled();
		},
	);

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
		expect(orpc.updateSettings).not.toHaveBeenCalled();
	});

	/**
	 * The page's snapshot of the conversation can predate an execution
	 * another tab saved. A settings change used to write that snapshot's
	 * metadata back whole, erasing the execution (Fizzy #2949); it now sends
	 * only the settings, for the server to merge under its row lock.
	 */
	it("sends only the changed settings, never the snapshot's executions", async () => {
		render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_drawer"
				activeConversation={conversation([])}
			/>,
		);
		await screen.findByText("Question from the drawer");

		fireEvent.click(screen.getByRole("button", { name: "pick chat tool" }));

		await waitFor(() =>
			expect(orpc.updateSettings).toHaveBeenCalledTimes(1),
		);
		expect(orpc.updateSettings).toHaveBeenCalledWith({
			conversationId: "conv_drawer",
			organizationId: undefined,
			settings: {
				executionMode: "balanced",
				instanceId: undefined,
				selectedMcpConfigIds: ["mcp_1"],
			},
		});
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
