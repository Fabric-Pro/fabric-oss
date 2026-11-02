/**
 * Create Plan's "Refine request with AI" picks its transport once, when the
 * form mounts (`COPILOTKIT_WEAVE_REFINE_CHAT`):
 *
 *   - off, or no organization on screen: each input goes to
 *     `weave.plans.refine` and the whole reply shows at once;
 *   - on: it runs the agent runtime's `weave-refine` agent in the
 *     organization on screen, a new thread per input; the feedback shows as
 *     it streams, and the improved request, the ready banner and "Use
 *     refined request" change only when the reply is complete;
 *   - a flag flipped after mount changes nothing until the next mount;
 *   - each follow-up carries the improved request and the exchanges so far;
 *   - a failure toasts its message and takes the input back out, leaving
 *     the request as it was; unmounting lets go of a run silently.
 */
import type { AGUIEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
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
	refine: vi.fn(),
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

vi.mock("sonner", () => ({
	toast: {
		error: (...args: unknown[]) => m.toastError(...args),
		success: vi.fn(),
	},
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "COPILOTKIT_WEAVE_REFINE_CHAT" && m.flagOn,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: m.organizationOnScreen,
		basePath: "/app/example-org",
	}),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		weave: {
			templates: {
				list: async () => ({ templates: [] }),
				use: vi.fn(),
			},
			plans: {
				refine: (...args: unknown[]) => m.refine(...args),
			},
		},
	},
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

const { CreatePlanForm } = await import("../CreatePlanForm");

const PROJECT = "project-example-1";
const ORG = "org-example-1";
const REQUEST = "Add login";
const U1 = "Add login with an example provider";
const F1 = "Which provider?";
const RUN_URL = "/api/agents/runtime/agent/weave-refine/run";
const INPUT_PLACEHOLDER = "Add more context or constraints…";
const READY_BANNER = "Request looks clear — ready to create plan.";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
	Element.prototype.scrollIntoView = () => {};
});

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve: (value: T) => void = () => {};
	let reject: (error: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** The runtime's reply events: the feedback, then the result, then the end. */
function runtimeReply(reply: {
	feedback: string;
	updatedMessage: string;
	isReady: boolean;
	finished?: boolean;
}): (emit: (event: AGUIEvent) => void) => Promise<void> {
	return async (emit) => {
		emit({ type: EventType.RUN_STARTED, threadId: "thread", runId: "run" });
		emit({
			type: EventType.TEXT_MESSAGE_START,
			messageId: "run:feedback",
			role: "assistant",
		});
		if (reply.feedback) {
			emit({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "run:feedback",
				delta: reply.feedback,
			});
		}
		emit({ type: EventType.TEXT_MESSAGE_END, messageId: "run:feedback" });
		emit({
			type: EventType.CUSTOM,
			name: "fabric.weave-refine.result",
			value: {
				updatedMessage: reply.updatedMessage,
				isReady: reply.isReady,
			},
		});
		if (reply.finished !== false) {
			emit({
				type: EventType.RUN_FINISHED,
				threadId: "thread",
				runId: "run",
			});
		}
	};
}

/** A refusal the runtime answers with, before any reply. */
function runtimeRefusal(
	code: string,
	message: string,
): (emit: (event: AGUIEvent) => void) => Promise<void> {
	return async (emit) => {
		emit({ type: EventType.RUN_ERROR, code, message });
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

function form(onSubmit = vi.fn()) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const element = () => (
		<QueryClientProvider client={client}>
			<CreatePlanForm
				onSubmit={onSubmit}
				isSubmitting={false}
				projectId={PROJECT}
			/>
		</QueryClientProvider>
	);
	const rendered = render(element());
	return {
		...rendered,
		onSubmit,
		rerender: () => rendered.rerender(element()),
	};
}

function requestField(): HTMLTextAreaElement {
	return screen.getByLabelText("Request") as HTMLTextAreaElement;
}

function refinementField(): HTMLInputElement {
	return screen.getByPlaceholderText(INPUT_PLACEHOLDER) as HTMLInputElement;
}

/** Writes the request and opens the refinement panel. */
function startRefining(request = REQUEST) {
	fireEvent.change(requestField(), { target: { value: request } });
	fireEvent.click(
		screen.getByRole("button", { name: /Refine request with AI/ }),
	);
}

function sendRefinement(text: string) {
	fireEvent.change(refinementField(), { target: { value: text } });
	fireEvent.click(screen.getByRole("button", { name: "Send refinement" }));
}

/** The chat bubbles, in order. */
function bubbles(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll(".whitespace-pre-wrap")).map(
		(bubble) => bubble.textContent ?? "",
	);
}

function messagesOf(input: RunAgentInput) {
	return input.messages.map((message) => ({
		role: message.role,
		content: message.content,
	}));
}

beforeEach(() => {
	m.flagOn = false;
	m.organizationOnScreen = ORG;
	m.runs.length = 0;
	m.respond = null;
	m.refine.mockReset();
	m.toastError.mockReset();
});

afterEach(() => {
	cleanup();
});

describe("with the flag off", () => {
	it("keeps the legacy failure toast when the form unmounts before the reply", async () => {
		const reply = deferred<never>();
		m.refine.mockReturnValue(reply.promise);
		const { unmount } = form();
		startRefining();
		sendRefinement("Tokens, please");
		await waitFor(() => expect(m.refine).toHaveBeenCalledTimes(1));
		unmount();
		await act(async () => {
			reply.reject(new Error("Example refinement failure"));
		});
		expect(m.toastError).toHaveBeenCalledExactlyOnceWith(
			"Refinement failed: Example refinement failure",
		);
	});

	it("refines through weave.plans.refine and records no runtime run", async () => {
		m.refine.mockResolvedValue({
			success: true,
			feedback: F1,
			updatedMessage: U1,
			isReady: true,
		});
		form();
		startRefining();

		sendRefinement("Tokens, please");

		await waitFor(() => expect(requestField().value).toBe(U1));
		expect(m.refine).toHaveBeenCalledWith({
			projectId: PROJECT,
			organizationId: ORG,
			currentMessage: REQUEST,
			refinementInput: "Tokens, please",
			history: [],
		});
		expect(screen.getByText(READY_BANNER)).toBeTruthy();
		expect(screen.getByText(F1)).toBeTruthy();
		expect(m.runs).toEqual([]);
	});

	it("toasts a failure and takes the input back out", async () => {
		m.refine.mockRejectedValue(new Error("Model down"));
		const { container } = form();
		startRefining();

		sendRefinement("Tokens, please");

		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				"Refinement failed: Model down",
			),
		);
		await waitFor(() => expect(bubbles(container)).toEqual([]));
		expect(requestField().value).toBe(REQUEST);
	});

	it("holds the input while the call is pending", async () => {
		const pending = deferred<unknown>();
		m.refine.mockReturnValue(pending.promise);
		form();
		startRefining();

		sendRefinement("Tokens, please");

		await waitFor(() => expect(screen.getByText("Thinking…")).toBeTruthy());
		expect(refinementField().disabled).toBe(true);
		expect(
			(
				screen.getByRole("button", {
					name: "Send refinement",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);

		await act(async () => {
			pending.resolve({
				success: true,
				feedback: F1,
				updatedMessage: U1,
				isReady: false,
			});
		});
		await waitFor(() => expect(refinementField().disabled).toBe(false));
	});

	it("sends each follow-up with the improved request and the exchanges so far", async () => {
		m.refine
			.mockResolvedValueOnce({
				success: true,
				feedback: F1,
				updatedMessage: U1,
				isReady: false,
			})
			.mockResolvedValueOnce({
				success: true,
				feedback: "Clear now.",
				updatedMessage: "U2",
				isReady: true,
			});
		form();
		startRefining();

		sendRefinement("Tokens, please");
		await waitFor(() => expect(requestField().value).toBe(U1));
		sendRefinement("Example provider");
		await waitFor(() => expect(requestField().value).toBe("U2"));

		expect(m.refine).toHaveBeenLastCalledWith({
			projectId: PROJECT,
			organizationId: ORG,
			currentMessage: U1,
			refinementInput: "Example provider",
			history: [
				{ role: "user", content: "Tokens, please" },
				{ role: "assistant", content: F1 },
			],
		});
	});
});

describe("with the flag on and an organization on screen", () => {
	beforeEach(() => {
		m.flagOn = true;
	});

	it("runs the weave-refine agent in the organization on screen, a new thread per input", async () => {
		m.respond = runtimeReply({
			feedback: F1,
			updatedMessage: U1,
			isReady: false,
		});
		form();
		startRefining();

		sendRefinement("Tokens, please");
		await waitFor(() => expect(requestField().value).toBe(U1));
		m.respond = runtimeReply({
			feedback: "Clear now.",
			updatedMessage: "U2",
			isReady: true,
		});
		sendRefinement("Example provider");
		await waitFor(() => expect(requestField().value).toBe("U2"));

		expect(m.refine).not.toHaveBeenCalled();
		expect(m.runs).toHaveLength(2);
		const [first, second] = m.runs;
		expect(first?.url).toBe(RUN_URL);
		expect(first?.org).toBe(ORG);
		expect(first?.input.forwardedProps).toEqual({
			projectId: PROJECT,
			currentMessage: REQUEST,
		});
		expect(messagesOf(first?.input as RunAgentInput)).toEqual([
			{ role: "user", content: "Tokens, please" },
		]);
		expect(second?.input.forwardedProps).toEqual({
			projectId: PROJECT,
			currentMessage: U1,
		});
		expect(messagesOf(second?.input as RunAgentInput)).toEqual([
			{ role: "user", content: "Tokens, please" },
			{ role: "assistant", content: F1 },
			{ role: "user", content: "Example provider" },
		]);
		expect(second?.input.threadId).not.toBe(first?.input.threadId);
	});

	it("shows the feedback as it streams and applies the result only when the run finishes", async () => {
		const rest = deferred<void>();
		m.respond = async (emit) => {
			emit({
				type: EventType.RUN_STARTED,
				threadId: "thread",
				runId: "run",
			});
			emit({
				type: EventType.TEXT_MESSAGE_START,
				messageId: "run:feedback",
				role: "assistant",
			});
			emit({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "run:feedback",
				delta: "Which",
			});
			await rest.promise;
			emit({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "run:feedback",
				delta: " provider?",
			});
			emit({
				type: EventType.TEXT_MESSAGE_END,
				messageId: "run:feedback",
			});
			emit({
				type: EventType.CUSTOM,
				name: "fabric.weave-refine.result",
				value: { updatedMessage: U1, isReady: true },
			});
			emit({
				type: EventType.RUN_FINISHED,
				threadId: "thread",
				runId: "run",
			});
		};
		const { container, onSubmit } = form();
		fireEvent.change(screen.getByLabelText("Plan Name"), {
			target: { value: "Example plan" },
		});
		startRefining();

		sendRefinement("Tokens, please");

		await waitFor(() =>
			expect(bubbles(container)).toEqual(["Tokens, please", "Which"]),
		);
		expect(screen.queryByText("Thinking…")).toBeNull();
		expect(requestField().value).toBe(REQUEST);
		expect(screen.queryByText("Use refined request")).toBeNull();
		expect(screen.queryByText(READY_BANNER)).toBeNull();

		await act(async () => {
			rest.resolve();
		});

		await waitFor(() => expect(requestField().value).toBe(U1));
		expect(bubbles(container)).toEqual(["Tokens, please", F1]);
		expect(screen.getByText(READY_BANNER)).toBeTruthy();
		expect(screen.getByText("Use refined request")).toBeTruthy();
		expect(refinementField().disabled).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: /Create Plan/ }));
		expect(onSubmit).toHaveBeenCalledWith({
			name: "Example plan",
			description: "",
			message: U1,
		});
	});

	it("treats a result without RUN_FINISHED as an early end", async () => {
		m.respond = runtimeReply({
			feedback: F1,
			updatedMessage: U1,
			isReady: true,
			finished: false,
		});
		const { container } = form();
		startRefining();

		sendRefinement("Tokens, please");

		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				"Refinement failed: The reply ended early. Please try again.",
			),
		);
		await waitFor(() => expect(bubbles(container)).toEqual([]));
		expect(requestField().value).toBe(REQUEST);
		expect(screen.queryByText(READY_BANNER)).toBeNull();
	});

	it("toasts the run's refusal and takes the input back out", async () => {
		m.respond = runtimeRefusal("NOT_FOUND", "Project not found");
		const { container } = form();
		startRefining();

		sendRefinement("Tokens, please");

		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				"Refinement failed: Project not found",
			),
		);
		await waitFor(() => expect(bubbles(container)).toEqual([]));
		expect(requestField().value).toBe(REQUEST);
	});

	it("words an HTTP refusal of the runtime as the other runtime chats do", async () => {
		m.respond = async () => {
			const payload = { error: "Forbidden", message: "Forbidden org" };
			// What @ag-ui/client rejects with for an HTTP error.
			throw Object.assign(
				new Error(`HTTP 403: ${JSON.stringify(payload)}`),
				{ status: 403, payload },
			);
		};
		form();
		startRefining();

		sendRefinement("Tokens, please");

		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				"Refinement failed: Forbidden org",
			),
		);
	});

	it("adds an empty reply as an empty exchange, as the route does", async () => {
		m.respond = runtimeReply({
			feedback: "",
			updatedMessage: U1,
			isReady: false,
		});
		const { container } = form();
		startRefining();

		sendRefinement("Tokens, please");

		await waitFor(() => expect(requestField().value).toBe(U1));
		expect(bubbles(container)).toEqual(["Tokens, please", ""]);
		expect(screen.getByText("Use refined request")).toBeTruthy();
	});

	it("lets go of a run silently when the form unmounts", async () => {
		m.respond = (_emit, signal) => untilAborted(signal);
		const { unmount } = form();
		startRefining();
		sendRefinement("Tokens, please");
		await waitFor(() => expect(m.runs).toHaveLength(1));

		unmount();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});

		expect(m.runs[0]?.signal.aborted).toBe(true);
		expect(m.toastError).not.toHaveBeenCalled();
	});
});

describe("the transport is chosen when the form mounts", () => {
	it("stays on the route with the flag on but no organization on screen", async () => {
		m.flagOn = true;
		m.organizationOnScreen = null;
		m.refine.mockResolvedValue({
			success: true,
			feedback: F1,
			updatedMessage: U1,
			isReady: false,
		});
		form();
		startRefining();

		sendRefinement("Tokens, please");

		await waitFor(() => expect(requestField().value).toBe(U1));
		expect(m.refine).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null }),
		);
		expect(m.runs).toEqual([]);
	});

	it("keeps the route when the flag turns on after mount", async () => {
		m.refine.mockResolvedValue({
			success: true,
			feedback: F1,
			updatedMessage: U1,
			isReady: false,
		});
		const { rerender } = form();
		m.flagOn = true;
		rerender();
		startRefining();

		sendRefinement("Tokens, please");

		await waitFor(() => expect(requestField().value).toBe(U1));
		expect(m.refine).toHaveBeenCalledTimes(1);
		expect(m.runs).toEqual([]);
	});

	it("keeps the runtime when the flag turns off after mount, and shows the runtime's refusal", async () => {
		m.flagOn = true;
		m.respond = runtimeRefusal(
			"FEATURE_DISABLED",
			"Weave plan refinement is not enabled on the agent runtime for this organization.",
		);
		const { container, rerender } = form();
		m.flagOn = false;
		rerender();
		startRefining();

		sendRefinement("Tokens, please");

		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				"Refinement failed: Weave plan refinement is not enabled on the agent runtime for this organization.",
			),
		);
		expect(m.runs.map((run) => run.url)).toEqual([RUN_URL]);
		expect(m.refine).not.toHaveBeenCalled();
		await waitFor(() => expect(bubbles(container)).toEqual([]));
		expect(requestField().value).toBe(REQUEST);
	});
});
