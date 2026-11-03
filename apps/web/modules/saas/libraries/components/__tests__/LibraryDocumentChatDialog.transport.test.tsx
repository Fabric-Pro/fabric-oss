/**
 * The library's Chat with Documents picks its transport once, when it
 * mounts (`COPILOTKIT_LIBRARY_CHAT`):
 *
 *   - off, or no organization on screen: the question goes to
 *     `/api/workspaces/chat` and the whole answer shows at once;
 *   - on: it runs the agent runtime's `library-chat` agent in the
 *     organization on screen; the source cards show when the sources arrive
 *     and the answer shows as it streams;
 *   - a flag flipped after mount changes nothing until the next mount;
 *   - closing the dialog lets go of the question on either transport: the
 *     request is aborted, nothing it answers afterwards lands, and the next
 *     opening starts empty on a new runtime thread; unmounting lets go of it
 *     too, with no error shown;
 *   - a follow-up carries the conversation so far;
 *   - an HTTP refusal shows its message, and a runtime reply that ends
 *     without finishing shows as lost, never as an answer.
 */
import type { AGUIEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const m = vi.hoisted(() => ({
	flagOn: false,
	organizationOnScreen: "org-example-1" as string | null,
	runs: [] as Array<{
		url: string;
		input: RunAgentInput;
		org?: string;
		signal: AbortSignal;
	}>,
	respond: null as
		| null
		| ((
				emit: (event: AGUIEvent) => void,
				signal: AbortSignal,
		  ) => Promise<void>),
	toastError: vi.fn(),
}));

vi.mock("@saas/agents/components/FabricChat/shared/AnsweredByModel", () => ({
	AnsweredByModel: ({ model }: { model?: { id: string } }) =>
		model ? <span>Answered by {model.id}</span> : null,
}));

vi.mock("sonner", async (importOriginal) => ({
	...(await importOriginal<typeof import("sonner")>()),
	toast: { error: (...args: unknown[]) => m.toastError(...args) },
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "COPILOTKIT_LIBRARY_CHAT" && m.flagOn,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useEffectiveOrganizationId: (id?: string | null) =>
		id === undefined ? m.organizationOnScreen : id,
	useOrganizationContext: () => ({ organizationId: m.organizationOnScreen }),
}));

vi.mock(
	"@saas/agents/lib/direct-runtime-transport",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@saas/agents/lib/direct-runtime-transport")
		>()),
		streamRuntime: async (args: {
			url: string;
			input: RunAgentInput;
			organizationId?: string;
			signal: AbortSignal;
			onEvent: (event: AGUIEvent) => void;
		}) => {
			m.runs.push({
				url: args.url,
				input: args.input,
				org: args.organizationId,
				signal: args.signal,
			});
			await m.respond?.(args.onEvent, args.signal);
		},
	}),
);

vi.mock("../../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { LibraryDocumentChatDialog } = await import(
	"../LibraryDocumentChatDialog"
);

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
});

const originalFetch = global.fetch;
const fetchMock = vi.fn<typeof fetch>();

/** The route's whole answer, as `/api/workspaces/chat` sends it. */
function routeAnswer(response: string): Response {
	return new Response(
		JSON.stringify({
			response,
			sources: [
				{
					filename: "route.pdf",
					chunkIndex: 0,
					score: 0.5,
					content: "Route passage",
				},
			],
		}),
		{ status: 200 },
	);
}

/** A runtime run that answers `text` and finishes. */
function runtimeAnswer(
	text: string,
): (emit: (event: AGUIEvent) => void) => Promise<void> {
	return async (emit) => {
		emit({ type: EventType.RUN_STARTED, threadId: "thread", runId: "run" });
		emit({
			type: EventType.TEXT_MESSAGE_START,
			messageId: "answer",
			role: "assistant",
		});
		emit({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "answer",
			delta: text,
		});
		emit({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" });
		emit({
			type: EventType.RUN_FINISHED,
			threadId: "thread",
			runId: "run",
		});
	};
}

/** Rejects as `fetch` does once its request is aborted. */
function untilAborted(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		signal.addEventListener("abort", () =>
			reject(
				Object.assign(new Error("The operation was aborted."), {
					name: "AbortError",
				}),
			),
		);
	});
}

beforeEach(() => {
	m.flagOn = false;
	m.organizationOnScreen = "org-example-1";
	m.runs.length = 0;
	m.respond = null;
	m.toastError.mockReset();
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () =>
		routeAnswer("Answer from the route"),
	);
	global.fetch = fetchMock;
});

afterEach(() => {
	cleanup();
	global.fetch = originalFetch;
});

function dialog(open = true) {
	return (
		<LibraryDocumentChatDialog
			open={open}
			onOpenChange={() => undefined}
			workspaceId="workspace-example-1"
			workspaceName="Example library"
			documentCount={2}
			organizationId={null}
		/>
	);
}

function ask(question: string) {
	fireEvent.change(
		screen.getByPlaceholderText("Ask about your documents..."),
		{
			target: { value: question },
		},
	);
	fireEvent.keyDown(
		screen.getByPlaceholderText("Ask about your documents..."),
		{
			key: "Enter",
		},
	);
}

describe("LibraryDocumentChatDialog transport", () => {
	it("renders the served footer and leaves a later unknown answer unlabeled", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						response: "First answer",
						model: { id: "example-served", viaPlan: false },
					}),
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ response: "Second answer" })),
			);
		render(dialog());
		ask("First question");
		await screen.findByText("Answered by example-served");
		ask("Next question");
		await screen.findByText("Second answer");
		expect(screen.getAllByText("Answered by example-served")).toHaveLength(
			1,
		);
	});
	it("asks the route while the flag is off", async () => {
		render(dialog());

		ask("When does it ship?");

		await waitFor(() =>
			expect(screen.getByText("Answer from the route")).toBeTruthy(),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspaces/chat",
			expect.objectContaining({ method: "POST" }),
		);
		expect(screen.getByText("route.pdf")).toBeTruthy();
		expect(m.runs).toEqual([]);
	});

	it("streams from the runtime's library-chat agent while the flag is on", async () => {
		m.flagOn = true;
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		m.respond = async (emit) => {
			emit({
				type: EventType.RUN_STARTED,
				threadId: "thread",
				runId: "run",
			});
			emit({
				type: EventType.CUSTOM,
				name: "fabric.library-chat.sources",
				value: {
					sources: [
						{
							filename: "plan.pdf",
							pageNumber: 2,
							chunkIndex: 0,
							score: 0.82,
							content: "The plan ships in May.",
						},
					],
				},
			});
			emit({
				type: EventType.TEXT_MESSAGE_START,
				messageId: "answer",
				role: "assistant",
			});
			emit({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "answer",
				delta: "It ships ",
			});
			await held;
			emit({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "answer",
				delta: "in May.",
			});
			emit({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" });
			emit({
				type: EventType.RUN_FINISHED,
				threadId: "thread",
				runId: "run",
			});
		};
		render(dialog());

		ask("When does it ship?");

		await waitFor(() => expect(screen.getByText("It ships")).toBeTruthy());
		expect(screen.getByText("plan.pdf")).toBeTruthy();
		await act(async () => {
			release();
		});
		await waitFor(() =>
			expect(screen.getByText("It ships in May.")).toBeTruthy(),
		);
		expect(screen.getByText("plan.pdf")).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(m.runs).toHaveLength(1);
		expect(m.runs[0]?.url).toBe(
			"/api/agents/runtime/agent/library-chat/run",
		);
		expect(m.runs[0]?.org).toBe("org-example-1");
		expect(m.runs[0]?.input.forwardedProps).toEqual({
			workspaceId: "workspace-example-1",
		});
		expect(m.runs[0]?.input.messages.at(-1)).toMatchObject({
			role: "user",
			content: "When does it ship?",
		});
	});

	it("shows the runtime's refusal as the route's error is shown", async () => {
		m.flagOn = true;
		m.respond = async (emit) => {
			emit({
				type: EventType.RUN_ERROR,
				code: "FORBIDDEN",
				message: "You don't have access to this workspace",
			});
		};
		render(dialog());

		ask("When does it ship?");

		await waitFor(() =>
			expect(
				screen.getByText(
					"Error: You don't have access to this workspace",
				),
			).toBeTruthy(),
		);
	});

	it("stays on the route with no organization on screen", async () => {
		m.flagOn = true;
		m.organizationOnScreen = null;
		render(dialog());

		ask("When does it ship?");

		await waitFor(() =>
			expect(screen.getByText("Answer from the route")).toBeTruthy(),
		);
		expect(m.runs).toEqual([]);
	});

	it("keeps the transport it mounted with when the flag flips", async () => {
		const { rerender } = render(dialog());
		m.flagOn = true;
		rerender(dialog());

		ask("When does it ship?");

		await waitFor(() =>
			expect(screen.getByText("Answer from the route")).toBeTruthy(),
		);
		expect(m.runs).toEqual([]);
	});

	it.each([
		["the route", false],
		["the runtime", true],
	])(
		"lets go of a question on %s silently when the dialog unmounts mid-answer",
		async (_transport, flagOn) => {
			m.flagOn = flagOn;
			m.respond = async (emit, signal) => {
				emit({
					type: EventType.RUN_STARTED,
					threadId: "thread",
					runId: "run",
				});
				await untilAborted(signal);
			};
			fetchMock.mockImplementationOnce((_url, init) =>
				init?.signal
					? untilAborted(init.signal)
					: new Promise(() => {}),
			);
			const { unmount } = render(dialog());
			ask("When does it ship?");
			await waitFor(() =>
				expect(m.runs.length + fetchMock.mock.calls.length).toBe(1),
			);

			unmount();
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
			});

			const signal = flagOn
				? m.runs[0]?.signal
				: fetchMock.mock.calls[0]?.[1]?.signal;
			expect(signal?.aborted).toBe(true);
			expect(m.toastError).not.toHaveBeenCalled();
		},
	);

	it("lets go of a streaming runtime answer when closed: no error, an empty dialog on reopening, a new thread", async () => {
		m.flagOn = true;
		m.respond = async (emit, signal) => {
			emit({
				type: EventType.RUN_STARTED,
				threadId: "thread",
				runId: "run",
			});
			emit({
				type: EventType.TEXT_MESSAGE_START,
				messageId: "answer",
				role: "assistant",
			});
			emit({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "answer",
				delta: "It ships ",
			});
			await untilAborted(signal);
		};
		const { rerender } = render(dialog());
		ask("When does it ship?");
		await waitFor(() => expect(screen.getByText("It ships")).toBeTruthy());

		rerender(dialog(false));
		await waitFor(() => expect(m.runs[0]?.signal.aborted).toBe(true));
		rerender(dialog());

		expect(
			screen.getByText("Ask anything about your documents"),
		).toBeTruthy();
		expect(screen.queryByText("It ships")).toBeNull();
		expect(screen.queryByText(/^Error:/)).toBeNull();
		expect(m.toastError).not.toHaveBeenCalled();

		m.respond = runtimeAnswer("Worldwide.");
		ask("Where does it ship?");
		await waitFor(() =>
			expect(screen.getByText("Worldwide.")).toBeTruthy(),
		);
		expect(m.runs).toHaveLength(2);
		expect(m.runs[1]?.input.threadId).not.toBe(m.runs[0]?.input.threadId);
		expect(m.runs[1]?.input.messages).toEqual([
			expect.objectContaining({
				role: "user",
				content: "Where does it ship?",
			}),
		]);
	});

	it("sends the conversation so far with a follow-up on the runtime", async () => {
		m.flagOn = true;
		m.respond = runtimeAnswer("It ships in May.");
		render(dialog());
		ask("When does it ship?");
		await waitFor(() =>
			expect(screen.getByText("It ships in May.")).toBeTruthy(),
		);

		m.respond = runtimeAnswer("Worldwide.");
		ask("Where does it ship?");
		await waitFor(() =>
			expect(screen.getByText("Worldwide.")).toBeTruthy(),
		);

		expect(m.runs).toHaveLength(2);
		expect(m.runs[1]?.input.threadId).toBe(m.runs[0]?.input.threadId);
		expect(m.runs[1]?.input.messages).toEqual([
			expect.objectContaining({
				role: "user",
				content: "When does it ship?",
			}),
			expect.objectContaining({
				role: "assistant",
				content: "It ships in May.",
			}),
			expect.objectContaining({
				role: "user",
				content: "Where does it ship?",
			}),
		]);
	});

	it("drops the route's answer to a question asked before the dialog closed", async () => {
		let answerFirst: (response: Response) => void = () => undefined;
		fetchMock.mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					answerFirst = resolve;
				}),
		);
		const { rerender } = render(dialog());
		ask("When does it ship?");
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

		rerender(dialog(false));
		rerender(dialog());
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

		ask("Where does it ship?");
		await waitFor(() =>
			expect(screen.getByText("Answer from the route")).toBeTruthy(),
		);
		await act(async () => {
			answerFirst(routeAnswer("Answer to the closed question"));
			await new Promise((resolve) => setTimeout(resolve, 20));
		});

		expect(screen.queryByText("Answer to the closed question")).toBeNull();
		expect(screen.getAllByText("Answer from the route")).toHaveLength(1);
		expect(
			JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).history,
		).toEqual([]);
	});

	it("words an HTTP refusal of the runtime as the other runtime chats do", async () => {
		m.flagOn = true;
		m.respond = async () => {
			const payload = {
				error: "Unauthorized",
				message: "Sign in to use the agent runtime.",
			};
			// What @ag-ui/client rejects with for an HTTP error.
			throw Object.assign(
				new Error(`HTTP 401: ${JSON.stringify(payload)}`),
				{ status: 401, payload },
			);
		};
		render(dialog());

		ask("When does it ship?");

		await waitFor(() =>
			expect(
				screen.getByText("Error: Sign in to use the agent runtime."),
			).toBeTruthy(),
		);
		expect(screen.queryByText(/HTTP 401/)).toBeNull();
		expect(m.toastError).toHaveBeenCalledWith("Chat error", {
			description: "Sign in to use the agent runtime.",
		});
	});

	it("shows a runtime reply that ends without finishing as dropped, never as an answer", async () => {
		m.flagOn = true;
		m.respond = async (emit) => {
			emit({
				type: EventType.RUN_STARTED,
				threadId: "thread",
				runId: "run",
			});
			emit({
				type: EventType.TEXT_MESSAGE_START,
				messageId: "answer",
				role: "assistant",
			});
			emit({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "answer",
				delta: "It ships ",
			});
		};
		render(dialog());

		ask("When does it ship?");

		await waitFor(() =>
			expect(
				screen.getByText(
					"Error: The connection to this reply was lost. Please try again.",
				),
			).toBeTruthy(),
		);
		expect(screen.queryByText("It ships")).toBeNull();
		expect(
			screen.queryByText(
				"I couldn't find relevant information in the documents.",
			),
		).toBeNull();
	});
});
