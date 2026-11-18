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
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as turnImages from "../orchestrator/turn-images";

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
		ai: {
			documents: {
				createUploadUrl: vi.fn(async () => ({
					documentId: "example-document",
					chatId: "example-chat",
					useServerUpload: true,
				})),
				upload: vi.fn(async () => ({})),
				process: vi.fn(async () => ({ extractedContent: "" })),
			},
		},
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
			isLoading,
		}: {
			value: string;
			onChange: (value: string) => void;
			onSend: () => void;
			isLoading?: boolean;
		}) => (
			<div>
				<textarea
					aria-label="Message"
					disabled={isLoading}
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
		client,
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

it("shows a text-only question while conversation admission prepares the send", async () => {
	let release!: () => void;
	orpc.create.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = () => resolve({ id: "example-conversation" });
			}),
	);
	const sendMessage = vi.fn(async () => null);
	streamState.current = idleStream({ sendMessage, transport: "legacy" });
	renderChat(
		<FabricTemporalOrchestratorChat
			organizationId="example-org"
			compactMode
		/>,
	);
	await send("Prepare this request");
	expect(screen.getByText("Prepare this request")).toBeVisible();
	expect(screen.getByTestId("send-preparation-status")).toHaveTextContent(
		"Preparing message",
	);
	expect(
		screen.queryByText("What can I help you with?"),
	).not.toBeInTheDocument();
	await send("Duplicate request");
	expect(sendMessage).not.toHaveBeenCalled();
	await act(async () => release());
	expect(sendMessage).toHaveBeenCalledTimes(1);
	expect(screen.getByTestId("send-preparation-status")).toBeEmptyDOMElement();
});

it("invalidates the history prefix when the runtime starts a conversation", async () => {
	const { client } = renderChat(
		<FabricTemporalOrchestratorChat organizationId="example-org" />,
	);
	const invalidate = vi.spyOn(client, "invalidateQueries");
	await act(async () => {
		streamOptions.current?.onConversationStarted?.("example-conversation");
	});
	expect(invalidate).toHaveBeenCalledWith({
		queryKey: ["agents", "conversations"],
	});
});

it("shows the question while three storage images upload concurrently", async () => {
	URL.createObjectURL = vi.fn(() => "blob:example");
	URL.revokeObjectURL = vi.fn();
	const releases: Array<() => void> = [];
	const fetchMock = vi.fn(
		() =>
			new Promise<Response>((resolve) => {
				releases.push(() =>
					resolve({
						ok: true,
						json: async () => ({
							storagePath: "example/image.png",
						}),
					} as Response),
				);
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	streamState.current = idleStream({
		sendMessage: vi.fn(async () => {
			streamState.current = idleStream({
				messages: [
					{
						id: "example-user",
						role: "user",
						content: "Review these three images",
					},
				],
				isLoading: true,
			});
		}),
	});
	const { container } = renderChat(
		<FabricTemporalOrchestratorChat
			organizationId="example-org"
			compactMode
		/>,
	);
	const files = ["a.png", "b.png", "c.png"].map(
		(name) => new File(["image"], name, { type: "image/png" }),
	);
	await act(async () =>
		fireEvent.change(
			container.querySelector('input[type="file"]') as HTMLInputElement,
			{
				target: { files },
			},
		),
	);
	await send("Review these three images");
	await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
	expect(screen.getByText("Review these three images")).toBeVisible();
	expect(screen.getByTestId("send-preparation-status")).toHaveTextContent(
		"Preparing message",
	);
	expect(
		screen.queryByText("What can I help you with?"),
	).not.toBeInTheDocument();
	await act(async () =>
		releases.forEach((release) => {
			release();
		}),
	);
	await waitFor(() =>
		expect(
			screen.queryByTestId("send-preparation-status"),
		).toBeEmptyDOMElement(),
	);
	expect(screen.getAllByText("Review these three images")).toHaveLength(1);
	vi.unstubAllGlobals();
});

vi.mock("@saas/projects/lib/image-upload-utils", () => ({
	prepareImageForAi: vi.fn(async (file: File) => ({ ok: true, file })),
}));

it("restores the draft and clears progress when image preparation rejects", async () => {
	URL.createObjectURL = vi.fn(() => "blob:example");
	URL.revokeObjectURL = vi.fn();
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				({
					ok: true,
					json: async () => ({ storagePath: "example/image.png" }),
				}) as Response,
		),
	);
	const errorToast = vi.spyOn(toast, "error");
	const upload = vi
		.spyOn(turnImages, "uploadTurnImagesAsDocuments")
		.mockRejectedValueOnce(new Error("Example preparation failure"));
	const { container } = renderChat(
		<FabricTemporalOrchestratorChat
			organizationId="example-org"
			compactMode
		/>,
	);
	await act(async () =>
		fireEvent.change(
			container.querySelector('input[type="file"]') as HTMLInputElement,
			{
				target: {
					files: [
						new File(["image"], "a.png", { type: "image/png" }),
					],
				},
			},
		),
	);
	await send("Keep my draft");
	await waitFor(() =>
		expect(screen.getByLabelText("Message")).toHaveValue("Keep my draft"),
	);
	expect(
		screen.queryByTestId("send-preparation-status"),
	).toBeEmptyDOMElement();
	expect(errorToast).toHaveBeenCalledWith("Failed to prepare message");
	upload.mockRestore();
	errorToast.mockRestore();
	vi.unstubAllGlobals();
});

it("uploads orchestrator documents concurrently, skips one rejection, and keeps order", async () => {
	const { orpcClient } = await import("@shared/lib/orpc-client");
	let next = 0;
	const create = vi
		.spyOn(orpcClient.ai.documents, "createUploadUrl")
		.mockImplementation(async () => {
			const id = ++next;
			return {
				documentId: `example-document-${id}`,
				chatId: "example-chat",
				signedUploadUrl: `https://example.com/upload/${id}`,
			} as Awaited<
				ReturnType<typeof orpcClient.ai.documents.createUploadUrl>
			>;
		});
	const releases: Array<() => void> = [];
	const rejectors: Array<(error: Error) => void> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(
			() =>
				new Promise<Response>((resolve, reject) => {
					releases.push(() => resolve({ ok: true } as Response));
					rejectors.push(reject);
				}),
		),
	);
	const errorToast = vi.spyOn((await import("sonner")).toast, "error");
	const { container } = renderChat(
		<FabricTemporalOrchestratorChat
			organizationId="example-org"
			compactMode
		/>,
	);
	await act(async () =>
		fireEvent.change(
			container.querySelector('input[type="file"]') as HTMLInputElement,
			{
				target: {
					files: ["a.txt", "b.txt", "c.txt"].map(
						(name) =>
							new File(["example"], name, { type: "text/plain" }),
					),
				},
			},
		),
	);
	await send("Read these documents");
	await waitFor(() => expect(releases).toHaveLength(3));
	expect(create.mock.calls.map(([input]) => input.chatId)).toEqual([
		undefined,
		"example-chat",
		"example-chat",
	]);
	expect(screen.getByTestId("send-preparation-status")).toHaveTextContent(
		"Preparing message",
	);
	await act(async () => {
		releases[2]();
		rejectors[1](new Error("Example upload failure"));
		releases[0]();
	});
	await waitFor(() =>
		expect(
			screen.queryByTestId("send-preparation-status"),
		).toBeEmptyDOMElement(),
	);
	const sendMessage = streamState.current.sendMessage as ReturnType<
		typeof vi.fn
	>;
	expect(sendMessage.mock.calls[0][9]).toEqual([
		"example-document-1",
		"example-document-3",
	]);
	expect(errorToast).toHaveBeenCalledTimes(1);
	expect(errorToast).toHaveBeenCalledWith("Failed to upload b.txt");
	create.mockRestore();
	errorToast.mockRestore();
	vi.unstubAllGlobals();
});

it.each(["legacy", "runtime"])(
	"releases preparation at %s handoff and accepts a send after Stop while the old send drains",
	async (transport) => {
		const releases: Array<() => void> = [];
		const sendMessage = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releases.push(resolve);
				}),
		);
		streamState.current = idleStream({ sendMessage, transport });
		const onStreamingChange = vi.fn();
		const props = {
			organizationId: "example-org",
			compactMode: true,
			onStreamingChange,
		};
		const view = renderChat(<FabricTemporalOrchestratorChat {...props} />);
		await send("First pending runtime turn");
		streamState.current = idleStream({
			sendMessage,
			transport,
			isLoading: true,
			messages: [
				{
					id: "first",
					role: "user",
					content: "First pending runtime turn",
				},
			],
		});
		view.rerender(<FabricTemporalOrchestratorChat {...props} />);
		streamState.current = { ...streamState.current, isLoading: false };
		view.rerender(<FabricTemporalOrchestratorChat {...props} />);
		expect(
			screen.getByTestId("send-preparation-status"),
		).toBeEmptyDOMElement();
		expect(screen.getByLabelText("Message")).toBeEnabled();
		expect(screen.getAllByText("First pending runtime turn")).toHaveLength(
			1,
		);
		expect(onStreamingChange).toHaveBeenLastCalledWith(true);
		await send("Second runtime turn");
		expect(sendMessage).toHaveBeenCalledTimes(2);
		await act(async () => {
			releases.forEach((release) => {
				release();
			});
		});
		expect(onStreamingChange).toHaveBeenLastCalledWith(false);
	},
);

it("keeps the preparation live region mounted and appends the pending question after existing messages", async () => {
	let release!: () => void;
	orpc.create.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = () => resolve({ id: "example-conversation" });
			}),
	);
	const sendMessage = vi.fn(async () => null);
	streamState.current = idleStream({
		sendMessage,
		transport: "legacy",
		messages: [{ id: "old", role: "user", content: "Existing question" }],
	});
	const view = renderChat(
		<FabricTemporalOrchestratorChat
			organizationId="example-org"
			compactMode
		/>,
	);
	const live = view.container.querySelector('[aria-live="polite"]');
	expect(live).toHaveTextContent("");
	await send("Pending follow-up question");
	expect(view.container.querySelector('[aria-live="polite"]')).toBe(live);
	expect(live).toHaveTextContent("Preparing message");
	const old = screen.getByText("Existing question");
	const pending = screen.getByText("Pending follow-up question");
	expect(
		old.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	await act(async () => release());
	expect(view.container.querySelector('[aria-live="polite"]')).toBe(live);
	expect(live).toBeEmptyDOMElement();
});
