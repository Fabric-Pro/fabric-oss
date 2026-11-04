import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	messages: [] as Array<{
		id: string;
		role: string;
		parts: Array<{ type: string; text: string }>;
	}>,
	send: vi.fn(),
	stop: vi.fn(),
	status: "ready",
	error: undefined as Error | undefined,
	retry: vi.fn(),
	apply: vi.fn(),
	transport: {} as {
		prepareSendMessagesRequest?: (input: { messages: unknown[] }) => {
			body: Record<string, unknown>;
		};
	},
	snapshot: {
		name: "Example",
		description: "Example task",
		systemPromptMarkdown: "Use project context",
		systemPromptHtml: "<p>Use project context</p>",
		model: "example-model",
		tools: [{ id: "read-context", name: "Read context" }],
		skills: [] as string[],
		pendingSuggestions: [],
	},
}));
vi.mock("@ai-sdk/react", () => ({
	useChat: () => ({
		messages: h.messages,
		status: h.status,
		stop: h.stop,
		sendMessage: h.send,
		error: h.error,
		regenerate: h.retry,
	}),
}));
vi.mock("ai", () => ({
	DefaultChatTransport: class {
		constructor(input: typeof h.transport) {
			h.transport = input;
		}
	},
}));
vi.mock("../SidekickFormContext", () => ({
	useSidekickForm: () => ({
		getSnapshot: () => h.snapshot,
		setFormField: h.apply,
	}),
}));
vi.mock("../markdown/SidekickSuggestionHost", () => ({
	SidekickSuggestionHost: () => null,
}));
vi.mock("../../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@saas/ai/hooks/useLimitToast", () => ({
	useLimitToast: () => vi.fn(),
}));
vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	useShowAiUsageLimitToast: () => vi.fn(),
	isAiUsageLimitExceededPayload: () => false,
}));
vi.mock("@repo/ai/limits", () => ({ classifyLimitError: () => null }));
vi.mock("@saas/agents/hooks/useRuntimeChatTransport", () => ({
	useRuntimeChatTransport: () => "legacy",
}));
vi.mock("@saas/shared/hooks/use-auto-resize-textarea", () => ({
	useAutoResizeTextarea: () => undefined,
}));

import { AgentBuilderSidekick } from "../AgentBuilderSidekick";
import { parseSidekickDraftProposal, sidekickDisplayText } from "../proposals";

const tools =
	'<sidekick_apply_tools>\n[{"action":"add","toolId":"mcp:example-server","toolName":"Example MCP"}]\n</sidekick_apply_tools>';
const response = (text: string) => [
	{
		id: "example-response",
		role: "assistant",
		parts: [{ type: "text", text }],
	},
];

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, "scrollTo", {
		configurable: true,
		value: vi.fn(),
	});
	h.messages = [];
	h.status = "ready";
	h.stop.mockReset();
	h.error = undefined;
	h.retry.mockReset();
	h.send.mockReset();
	h.apply.mockReset();
	h.snapshot.tools = [{ id: "read-context", name: "Read context" }];
});
afterEach(() => vi.useRealTimers());
describe("Sidekick deliberate requests and configuration review", () => {
	it("explains a failed response without exposing provider details and retries only explicitly", () => {
		h.error = new Error("Private provider failure");
		const view = render(
			<AgentBuilderSidekick agentId="new" organizationId="example-org" />,
		);
		expect(view.getByRole("alert")).toHaveTextContent(
			"Sidekick could not respond",
		);
		expect(
			view.queryByText("Private provider failure"),
		).not.toBeInTheDocument();
		expect(h.retry).not.toHaveBeenCalled();
		fireEvent.click(view.getByRole("button", { name: "Retry response" }));
		expect(h.retry).toHaveBeenCalledTimes(1);
		expect(h.apply).not.toHaveBeenCalled();
	});
	it("does not start a model request on mount and sends the explicit organization with a user request", () => {
		vi.useFakeTimers();
		const view = render(
			<AgentBuilderSidekick agentId="new" organizationId="example-org" />,
		);
		act(() => vi.advanceTimersByTime(1000));
		expect(h.send).not.toHaveBeenCalled();
		fireEvent.change(
			view.getByRole("textbox", { name: "Message Sidekick" }),
			{ target: { value: "Suggest instructions" } },
		);
		fireEvent.click(view.getByRole("button", { name: "Send message" }));
		expect(h.send).toHaveBeenCalledWith({ text: "Suggest instructions" });
		expect(
			h.transport.prepareSendMessagesRequest?.({ messages: [] }).body,
		).toMatchObject({ organizationId: "example-org", agentId: "new" });
	});
	it("shows MCP additions for review without applying them until accepted", async () => {
		h.messages = response(tools);
		const view = render(
			<AgentBuilderSidekick agentId="new" organizationId="example-org" />,
		);
		await waitFor(() =>
			expect(
				view.getByRole("button", { name: "Apply suggested changes" }),
			).toBeInTheDocument(),
		);
		expect(h.apply).not.toHaveBeenCalled();
		expect(view.getByRole("alert")).toHaveTextContent("Example MCP");
		fireEvent.click(
			view.getByRole("button", { name: "Apply suggested changes" }),
		);
		expect(h.apply).toHaveBeenCalledTimes(1);
		const [field, update] = h.apply.mock.calls[0];
		expect(field).toBe("tools");
		expect(update(h.snapshot.tools)).toEqual([
			...h.snapshot.tools,
			{ id: "mcp:example-server", name: "Example MCP" },
		]);
		expect(view.getByRole("status")).toHaveTextContent(
			"Changes applied to the draft",
		);
	});
	it("can dismiss a suggested permission expansion without changing the draft", async () => {
		h.messages = response(tools);
		const view = render(
			<AgentBuilderSidekick agentId="new" organizationId="example-org" />,
		);
		fireEvent.click(
			await view.findByRole("button", { name: "Dismiss changes" }),
		);
		expect(h.apply).not.toHaveBeenCalled();
		expect(
			view.queryByRole("button", { name: "Apply suggested changes" }),
		).not.toBeInTheDocument();
	});
	it("refuses to apply stale tool changes after the user edited the draft", async () => {
		h.messages = response(tools);
		const view = render(
			<AgentBuilderSidekick agentId="new" organizationId="example-org" />,
		);
		await view.findByRole("button", { name: "Apply suggested changes" });
		h.snapshot = {
			...h.snapshot,
			tools: [{ id: "another-tool", name: "User-selected tool" }],
		};
		fireEvent.click(
			view.getByRole("button", { name: "Apply suggested changes" }),
		);
		expect(h.apply).not.toHaveBeenCalled();
		expect(view.getByRole("status")).toHaveTextContent(
			"configuration changed",
		);
	});
	it("does not carry a draft proposal across organizations", async () => {
		h.messages = response(tools);
		const view = render(
			<AgentBuilderSidekick agentId="new" organizationId="example-org" />,
		);
		await view.findByRole("button", { name: "Apply suggested changes" });
		h.messages = [];
		h.error = undefined;
		h.retry.mockReset();
		view.rerender(
			<AgentBuilderSidekick
				agentId="new"
				organizationId="example-other-org"
			/>,
		);
		expect(
			view.queryByRole("button", { name: "Apply suggested changes" }),
		).not.toBeInTheDocument();
		expect(h.send).not.toHaveBeenCalled();
	});
	it("rejects malformed and oversized tool output and escapes model-authored instruction markup", () => {
		expect(
			parseSidekickDraftProposal(
				'<sidekick_apply_tools>[{"action":"execute","toolId":"anything"}]</sidekick_apply_tools>',
			),
		).toBeNull();
		expect(parseSidekickDraftProposal("x".repeat(128001))).toBeNull();
		const parsed = parseSidekickDraftProposal(
			"<sidekick_apply_instructions>Use &lt;script&gt; as plain text<img src=x onerror=alert(1)></sidekick_apply_instructions>",
		);
		expect(parsed?.instructions?.html).toBe(
			"<p>Use &lt;script&gt; as plain text</p>",
		);
	});
});

it("places the composer after the conversation and keeps requests deliberate", () => {
	const view = render(
		<AgentBuilderSidekick agentId="new" organizationId="example-org" />,
	);
	const input = view.getByRole("textbox", { name: "Message Sidekick" });
	const guidance = view.getByText(/What would you like this agent to do/);
	expect(
		guidance.compareDocumentPosition(input) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(h.send).not.toHaveBeenCalled();
	expect(view.getByRole("button", { name: "Send message" })).toBeDisabled();
});

it("offers a welcome question and starter prompts without sending a request", () => {
	const view = render(
		<AgentBuilderSidekick agentId="new" organizationId="example-org" />,
	);
	fireEvent.click(view.getByRole("button", { name: "Improve instructions" }));
	expect(
		(
			view.getByRole("textbox", {
				name: "Message Sidekick",
			}) as HTMLTextAreaElement
		).value,
	).toContain("Review my current instructions");
	expect(h.send).not.toHaveBeenCalled();
});
it("can stop a streaming response without applying suggestions", () => {
	h.status = "streaming";
	const view = render(
		<AgentBuilderSidekick agentId="new" organizationId="example-org" />,
	);
	fireEvent.click(view.getByRole("button", { name: "Stop response" }));
	expect(h.stop).toHaveBeenCalledOnce();
	expect(h.apply).not.toHaveBeenCalled();
});

it("hides complete and streaming draft-transfer markers while preserving the reviewable proposal", () => {
	expect(
		sidekickDisplayText(
			"A clearer prompt.\n<sidekick_apply_instructions><p>New instructions</p></sidekick_apply_instructions>\nReview below.",
		),
	).toBe("A clearer prompt.\n\nReview below.");
	expect(
		sidekickDisplayText(
			'A proposal. <sidekick_apply_tools>[{"action":"add"',
		),
	).toBe("A proposal.");
	expect(sidekickDisplayText("Discuss <context> plainly.")).toBe(
		"Discuss <context> plainly.",
	);
});
