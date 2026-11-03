/**
 * The CUGA chat picks its transport once, when it mounts
 * (`COPILOTKIT_CUGA_CHAT`):
 *
 *   - off, or no organization on screen: each message goes to
 *     `/api/agents/a2a/send`, as before;
 *   - on: it runs the agent runtime's `cuga-generalist` agent, a new thread
 *     per message, carrying the agent's conversation id from the last
 *     reply; the reply's reasoning shows as before;
 *   - a flag flipped after mount changes nothing until the next mount;
 *   - a failed runtime run shows the error toast and bubble, and a usage
 *     limit also shows the shared limit toast with its limits;
 *   - unmounting lets go of a message still waiting, on either transport,
 *     with no error shown, even when the relay fails afterwards.
 */
import { EventType, type RunAgentInput } from "@ag-ui/client";
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

const m = vi.hoisted(() => ({
	flagOn: false,
	organizationOnScreen: "org-example-1" as string | null,
	toastError: vi.fn(),
	showLimit: vi.fn(),
	/** The runtime run's events between RUN_STARTED and its end, by send. */
	runtimeEvents: null as
		| null
		| ((send: number) => Array<Record<string, unknown>>),
	/** Holds the runtime request until its signal aborts. */
	holdRuntime: false,
	/** Holds the relay request until its signal aborts or it is released. */
	holdRelay: false,
	/** Answers a held relay request with the relay's failure. */
	releaseRelay: () => {},
}));

vi.mock("sonner", async (importOriginal) => ({
	...(await importOriginal<typeof import("sonner")>()),
	toast: { error: (...args: unknown[]) => m.toastError(...args) },
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => key === "COPILOTKIT_CUGA_CHAT" && m.flagOn,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useEffectiveOrganizationId: (id?: string | null) =>
		id === undefined ? m.organizationOnScreen : id,
	useOrganizationContext: () => ({ organizationId: m.organizationOnScreen }),
}));

vi.mock("@saas/payments/lib/ai-usage-limit-toast", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/payments/lib/ai-usage-limit-toast")
	>()),
	useShowAiUsageLimitToast: () => m.showLimit,
}));

vi.mock("../../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../../../../components/ai-elements/reasoning", () => ({
	Reasoning: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	ReasoningTrigger: () => <button type="button">Reasoning</button>,
	ReasoningContent: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
}));

const { CugaAuthenticatedChat } = await import("../cuga/CugaAuthenticatedChat");

const LEGACY_URL = "/api/agents/a2a/send";
const RUNTIME_URL = "/api/agents/runtime/agent/cuga-generalist/run";

const USAGE_LIMIT = {
	limitId: "limit-1",
	dimension: "TOKENS",
	window: "MONTHLY",
	used: "10",
	max: "10",
	manageLimitsUrl: "https://example.com/limits",
};

const fetchMock = vi.fn<typeof fetch>();

function sse(events: Array<Record<string, unknown>>): Response {
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
}

/** A runtime reply: its conversation id, reasoning and answer, finished. */
function runtimeReply(send: number): Array<Record<string, unknown>> {
	return [
		{
			type: EventType.CUSTOM,
			name: "fabric.cuga-generalist.context",
			value: { contextId: `ctx-runtime-${send}` },
		},
		{ type: EventType.REASONING_START, messageId: "r" },
		{
			type: EventType.REASONING_MESSAGE_START,
			messageId: "r",
			role: "reasoning",
		},
		{
			type: EventType.REASONING_MESSAGE_CONTENT,
			messageId: "r",
			delta: `Reasoning ${send}`,
		},
		{ type: EventType.REASONING_MESSAGE_END, messageId: "r" },
		{ type: EventType.REASONING_END, messageId: "r" },
		{
			type: EventType.TEXT_MESSAGE_START,
			messageId: "a",
			role: "assistant",
		},
		{
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "a",
			delta: `Runtime answer ${send}`,
		},
		{ type: EventType.TEXT_MESSAGE_END, messageId: "a" },
	];
}

function abortError(): Error {
	return Object.assign(new Error("The operation was aborted."), {
		name: "AbortError",
	});
}

function urls(): string[] {
	return fetchMock.mock.calls.map(([url]) => String(url));
}

function runtimeInput(call: number): RunAgentInput {
	return JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body));
}

async function send(text: string) {
	const sent = fetchMock.mock.calls.length;
	const box = screen.getByRole("textbox");
	fireEvent.change(box, { target: { value: text } });
	fireEvent.keyDown(box, { key: "Enter", shiftKey: false });
	await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(sent + 1));
}

beforeEach(() => {
	m.flagOn = false;
	m.organizationOnScreen = "org-example-1";
	m.toastError.mockReset();
	m.showLimit.mockReset();
	m.runtimeEvents = runtimeReply;
	m.holdRuntime = false;
	m.holdRelay = false;
	m.releaseRelay = () => {};
	Element.prototype.scrollIntoView = vi.fn();
	let runtimeSends = 0;
	fetchMock.mockReset();
	fetchMock.mockImplementation(async (url, init) => {
		if (String(url) !== RUNTIME_URL) {
			if (m.holdRelay) {
				return new Promise<Response>((resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(abortError()),
					);
					m.releaseRelay = () =>
						resolve(
							Response.json(
								{ error: "The agent is unavailable" },
								{ status: 502 },
							),
						);
				});
			}
			return Response.json({
				response: "Legacy answer",
				contextId: "ctx-legacy-1",
			});
		}
		if (m.holdRuntime) {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(abortError()),
				);
			});
		}
		runtimeSends += 1;
		const { threadId, runId } = JSON.parse(String(init?.body));
		const events = m.runtimeEvents?.(runtimeSends) ?? [];
		const ended = events.some(
			(event) => event.type === EventType.RUN_ERROR,
		);
		return sse([
			{ type: EventType.RUN_STARTED, threadId, runId },
			...events,
			...(ended
				? []
				: [{ type: EventType.RUN_FINISHED, threadId, runId }]),
		]);
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("CugaAuthenticatedChat transport", () => {
	it("asks the relay while the flag is off", async () => {
		render(<CugaAuthenticatedChat />);

		await send("hello");

		expect(urls()).toEqual([LEGACY_URL]);
		expect(await screen.findByText("Legacy answer")).toBeTruthy();
	});

	it("runs the cuga-generalist agent while the flag is on, carrying the agent's conversation", async () => {
		m.flagOn = true;
		render(<CugaAuthenticatedChat />);

		await send("first");
		expect(await screen.findByText("Runtime answer 1")).toBeTruthy();
		expect(screen.getByText("Reasoning 1")).toBeTruthy();
		expect(
			screen.getAllByRole("button", { name: "Reasoning" }),
		).toHaveLength(1);
		await send("second");
		expect(await screen.findByText("Runtime answer 2")).toBeTruthy();

		expect(urls()).toEqual([RUNTIME_URL, RUNTIME_URL]);
		expect(
			new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
				"x-fabric-organization-id",
			),
		).toBe("org-example-1");
		expect(runtimeInput(0).forwardedProps).toEqual({
			agentId: "cuga_generalist",
			contextId: null,
		});
		expect(runtimeInput(1).forwardedProps).toEqual({
			agentId: "cuga_generalist",
			contextId: "ctx-runtime-1",
		});
		expect(runtimeInput(0).threadId).not.toBe(runtimeInput(1).threadId);
		expect(
			runtimeInput(1).messages.map(({ role, content }) => ({
				role,
				content,
			})),
		).toEqual([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "Runtime answer 1" },
			{ role: "user", content: "second" },
		]);
	});

	it("asks the relay when no organization is on screen", async () => {
		m.flagOn = true;
		m.organizationOnScreen = null;
		render(<CugaAuthenticatedChat />);

		await send("hello");

		expect(urls()).toEqual([LEGACY_URL]);
	});

	it("stays on the relay when the flag turns on after mount", async () => {
		const { rerender } = render(<CugaAuthenticatedChat />);
		m.flagOn = true;
		rerender(<CugaAuthenticatedChat />);

		await send("hello");

		expect(urls()).toEqual([LEGACY_URL]);
	});

	it("stays on the runtime when the flag turns off after mount", async () => {
		m.flagOn = true;
		const { rerender } = render(<CugaAuthenticatedChat />);
		m.flagOn = false;
		rerender(<CugaAuthenticatedChat />);

		await send("first");
		await screen.findByText("Runtime answer 1");
		await send("second");
		await screen.findByText("Runtime answer 2");

		expect(urls()).toEqual([RUNTIME_URL, RUNTIME_URL]);
	});

	it("shows a failed runtime run as the error toast and bubble", async () => {
		m.flagOn = true;
		m.runtimeEvents = () => [
			{
				type: EventType.RUN_ERROR,
				code: "RUN_FAILED",
				message: "The reply failed. Please try again.",
			},
		];
		render(<CugaAuthenticatedChat />);

		await send("hello");

		expect(
			await screen.findByText(
				"Error: The reply failed. Please try again.",
			),
		).toBeTruthy();
		expect(m.toastError).toHaveBeenCalledWith("Error", {
			description: "The reply failed. Please try again.",
		});
		expect(m.showLimit).not.toHaveBeenCalled();
	});

	it("shows a usage limit with the shared limit toast, as well as the error toast and bubble", async () => {
		m.flagOn = true;
		m.runtimeEvents = () => [
			{
				type: EventType.RUN_ERROR,
				code: "AI_USAGE_LIMIT_EXCEEDED",
				message: "AI usage limit exceeded",
				metadata: {
					fabric: {
						status: 429,
						code: "AI_USAGE_LIMIT_EXCEEDED",
						data: USAGE_LIMIT,
					},
				},
			},
		];
		render(<CugaAuthenticatedChat />);

		await send("hello");

		expect(
			await screen.findByText("Error: AI usage limit exceeded"),
		).toBeTruthy();
		expect(m.showLimit).toHaveBeenCalledWith(USAGE_LIMIT);
		expect(m.toastError).toHaveBeenCalledWith("Error", {
			description: "AI usage limit exceeded",
		});
	});

	it("lets go of a waiting message on unmount, with no error shown", async () => {
		m.flagOn = true;
		m.holdRuntime = true;
		const { unmount } = render(<CugaAuthenticatedChat />);

		await send("hello");
		unmount();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(m.toastError).not.toHaveBeenCalled();
	});

	it("lets go of a waiting relay message on unmount, with no error shown when the relay fails afterwards", async () => {
		m.holdRelay = true;
		const { unmount } = render(<CugaAuthenticatedChat />);

		await send("hello");
		unmount();
		await act(async () => {
			m.releaseRelay();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(urls()).toEqual([LEGACY_URL]);
		expect(m.toastError).not.toHaveBeenCalled();
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});
});
