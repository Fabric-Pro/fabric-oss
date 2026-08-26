import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CopilotAssistantMessage } from "../CopilotAssistantMessage";

// Mock CopilotKit hooks
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: vi.fn(),
	useCopilotChat: vi.fn(),
}));
vi.mock("@copilotkit/react-ui", () => ({
	Markdown: ({ content }: { content: string }) => (
		<div data-testid="markdown">{content}</div>
	),
	useChatContext: () => ({
		icons: {
			regenerateIcon: <span />,
			copyIcon: <span />,
			thumbsUpIcon: <span />,
			thumbsDownIcon: <span />,
			activityIcon: <span />,
		},
		labels: {
			regenerateResponse: "Regenerate",
			copyToClipboard: "Copy",
			thumbsUp: "Like",
			thumbsDown: "Dislike",
		},
	}),
}));
vi.mock("../ReasoningCollapsible", () => ({
	ReasoningCollapsible: ({
		text,
		durationMs,
		toolCalls,
	}: {
		text: string;
		durationMs?: number;
		toolCalls?: Array<{ id: string; name: string; status: string }>;
	}) => (
		<div
			data-testid="reasoning-collapsible"
			data-tool-count={toolCalls?.length ?? 0}
			data-tool-names={
				toolCalls?.map((t) => `${t.name}:${t.status}`).join(",") ?? ""
			}
		>
			reasoning:{text}:{durationMs ?? "none"}
		</div>
	),
}));
// Also mock McpAppFrame to avoid pulling its dep tree
vi.mock("../../../../../components/ai-elements/McpAppFrame", () => ({
	McpAppFrame: () => <div data-testid="mcp-frame" />,
}));

import { useCoAgent, useCopilotChat } from "@copilotkit/react-core";

const baseProps = {
	message: { id: "a1", content: "Assistant reply" } as any,
	isLoading: false,
	isGenerating: false,
	isCurrentMessage: true,
	onRegenerate: () => {},
	onCopy: () => {},
	onThumbsUp: () => {},
	onThumbsDown: () => {},
	markdownTagRenderers: {},
};

describe("CopilotAssistantMessage — reasoning lookup", () => {
	it("renders ReasoningCollapsible when useCoAgent has matching turn entry", () => {
		(useCopilotChat as any).mockReturnValue({
			visibleMessages: [
				{ id: "u1", role: "user" },
				{ id: "a1", role: "assistant" },
			],
		});
		(useCoAgent as any).mockReturnValue({
			state: {
				reasoningByTurn: {
					1: { text: "Some thinking", durationMs: 4200 },
				},
			},
		});
		render(<CopilotAssistantMessage {...baseProps} />);
		expect(screen.getByTestId("reasoning-collapsible")).toHaveTextContent(
			"reasoning:Some thinking:4200",
		);
	});

	it("does not render ReasoningCollapsible when no matching turn entry", () => {
		(useCopilotChat as any).mockReturnValue({
			visibleMessages: [
				{ id: "u1", role: "user" },
				{ id: "a1", role: "assistant" },
			],
		});
		(useCoAgent as any).mockReturnValue({
			state: { reasoningByTurn: {} },
		});
		render(<CopilotAssistantMessage {...baseProps} />);
		expect(
			screen.queryByTestId("reasoning-collapsible"),
		).not.toBeInTheDocument();
	});

	it("does not render ReasoningCollapsible on non-agent page (useCoAgent returns empty state)", () => {
		(useCopilotChat as any).mockReturnValue({
			visibleMessages: [
				{ id: "u1", role: "user" },
				{ id: "a1", role: "assistant" },
			],
		});
		(useCoAgent as any).mockReturnValue({ state: {} });
		render(<CopilotAssistantMessage {...baseProps} />);
		expect(
			screen.queryByTestId("reasoning-collapsible"),
		).not.toBeInTheDocument();
		// And the assistant message still renders normally
		expect(screen.getByTestId("markdown")).toHaveTextContent(
			"Assistant reply",
		);
	});

	it("computes turnIndex correctly for a later turn", () => {
		(useCopilotChat as any).mockReturnValue({
			visibleMessages: [
				{ id: "u1", role: "user" },
				{ id: "a-old", role: "assistant" },
				{ id: "u2", role: "user" },
				{ id: "a-new", role: "assistant" },
			],
		});
		(useCoAgent as any).mockReturnValue({
			state: {
				reasoningByTurn: {
					2: { text: "Turn 2 reasoning", durationMs: 3000 },
				},
			},
		});
		render(
			<CopilotAssistantMessage
				{...baseProps}
				message={{ id: "a-new", content: "Reply 2" } as any}
			/>,
		);
		expect(screen.getByTestId("reasoning-collapsible")).toHaveTextContent(
			"reasoning:Turn 2 reasoning:3000",
		);
	});

	it("returns null when message.id missing or not found in visibleMessages", () => {
		(useCopilotChat as any).mockReturnValue({
			visibleMessages: [],
		});
		(useCoAgent as any).mockReturnValue({
			state: {
				reasoningByTurn: { 1: { text: "x", durationMs: 100 } },
			},
		});
		render(<CopilotAssistantMessage {...baseProps} />);
		expect(
			screen.queryByTestId("reasoning-collapsible"),
		).not.toBeInTheDocument();
	});
});

describe("CopilotAssistantMessage — Thinking spinner", () => {
	it("shows a Thinking spinner during the loading gap (no content yet)", () => {
		(useCopilotChat as any).mockReturnValue({ visibleMessages: [] });
		(useCoAgent as any).mockReturnValue({ state: {} });
		render(
			<CopilotAssistantMessage
				{...baseProps}
				isLoading={true}
				message={{ id: "a1", content: "" } as any}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("Thinking");
	});

	it("hides the spinner once content has streamed in", () => {
		(useCopilotChat as any).mockReturnValue({ visibleMessages: [] });
		(useCoAgent as any).mockReturnValue({ state: {} });
		render(
			<CopilotAssistantMessage
				{...baseProps}
				isLoading={true}
				message={{ id: "a1", content: "Here is the answer" } as any}
			/>,
		);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});

describe("CopilotAssistantMessage — tool calls lookup", () => {
	it("renders ReasoningCollapsible with toolCalls when current turn has entries", () => {
		(useCopilotChat as any).mockReturnValue({
			visibleMessages: [
				{ id: "u1", role: "user" },
				{ id: "a1", role: "assistant" },
			],
		});
		(useCoAgent as any).mockReturnValue({
			state: {
				toolCallsByTurn: {
					1: [
						{
							id: "call_1",
							name: "write_document_local",
							status: "success",
							durationMs: 400,
						},
						{
							id: "call_2",
							name: "search_teams_messages",
							status: "pending",
						},
					],
				},
			},
		});
		render(<CopilotAssistantMessage {...baseProps} />);
		const el = screen.getByTestId("reasoning-collapsible");
		expect(el).toHaveAttribute("data-tool-count", "2");
		expect(el).toHaveAttribute(
			"data-tool-names",
			"write_document_local:success,search_teams_messages:pending",
		);
	});

	it("renders ReasoningCollapsible with BOTH reasoning AND toolCalls", () => {
		(useCopilotChat as any).mockReturnValue({
			visibleMessages: [
				{ id: "u1", role: "user" },
				{ id: "a1", role: "assistant" },
			],
		});
		(useCoAgent as any).mockReturnValue({
			state: {
				reasoningByTurn: {
					1: { text: "thoughts", durationMs: 4200 },
				},
				toolCallsByTurn: {
					1: [
						{
							id: "call_1",
							name: "apply_document_patches",
							status: "success",
							durationMs: 200,
						},
					],
				},
			},
		});
		render(<CopilotAssistantMessage {...baseProps} />);
		const el = screen.getByTestId("reasoning-collapsible");
		expect(el).toHaveTextContent("reasoning:thoughts:4200");
		expect(el).toHaveAttribute("data-tool-count", "1");
	});

	it("does not render when neither reasoning nor toolCalls have current turn entry", () => {
		(useCopilotChat as any).mockReturnValue({
			visibleMessages: [
				{ id: "u1", role: "user" },
				{ id: "a1", role: "assistant" },
			],
		});
		(useCoAgent as any).mockReturnValue({
			state: {
				reasoningByTurn: {},
				toolCallsByTurn: {},
			},
		});
		render(<CopilotAssistantMessage {...baseProps} />);
		expect(
			screen.queryByTestId("reasoning-collapsible"),
		).not.toBeInTheDocument();
	});

	it("treats empty toolCalls array for current turn as 'no entries'", () => {
		(useCopilotChat as any).mockReturnValue({
			visibleMessages: [
				{ id: "u1", role: "user" },
				{ id: "a1", role: "assistant" },
			],
		});
		(useCoAgent as any).mockReturnValue({
			state: { toolCallsByTurn: { 1: [] } },
		});
		render(<CopilotAssistantMessage {...baseProps} />);
		expect(
			screen.queryByTestId("reasoning-collapsible"),
		).not.toBeInTheDocument();
	});

	it("looks up toolCalls for a later turn correctly", () => {
		(useCopilotChat as any).mockReturnValue({
			visibleMessages: [
				{ id: "u1", role: "user" },
				{ id: "a-old", role: "assistant" },
				{ id: "u2", role: "user" },
				{ id: "a-new", role: "assistant" },
			],
		});
		(useCoAgent as any).mockReturnValue({
			state: {
				toolCallsByTurn: {
					1: [
						{
							id: "old_call",
							name: "old_tool",
							status: "success",
							durationMs: 50,
						},
					],
					2: [
						{
							id: "new_call",
							name: "write_document_local",
							status: "success",
							durationMs: 400,
						},
					],
				},
			},
		});
		render(
			<CopilotAssistantMessage
				{...baseProps}
				message={{ id: "a-new", content: "Reply 2" } as any}
			/>,
		);
		const el = screen.getByTestId("reasoning-collapsible");
		expect(el).toHaveAttribute(
			"data-tool-names",
			"write_document_local:success",
		);
	});
});

describe("CopilotAssistantMessage — footer (timestamp + controls)", () => {
	function setup(
		messageOverride: Record<string, unknown> = {},
		extraProps: Record<string, unknown> = {},
	) {
		(useCopilotChat as any).mockReturnValue({ visibleMessages: [] });
		(useCoAgent as any).mockReturnValue({ state: {} });
		return render(
			<CopilotAssistantMessage
				{...baseProps}
				{...extraProps}
				message={
					{ id: "a1", content: "Done.", ...messageOverride } as any
				}
			/>,
		);
	}

	it("renders the timestamp with a LOCAL-timezone title (never the UTC ISO)", () => {
		const ts = "2026-05-31T06:00:00.000Z";
		const { container } = setup({ createdAt: ts });
		const time = container.querySelector("time");
		expect(time).not.toBeNull();
		// dateTime stays the UTC ISO (HTML spec requires a global datetime)…
		expect(time?.getAttribute("datetime")).toBe(ts);
		// …but the hover title is the human local string, not the zulu ISO.
		const title = time?.getAttribute("title") ?? "";
		expect(title).not.toBe(ts);
		expect(title).not.toMatch(/Z$/);
		expect(title).toBe(
			new Date(ts).toLocaleString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
				timeZoneName: "short",
			}),
		);
	});

	it("places the timestamp and the action controls in one shared footer row", () => {
		const { container } = setup({ createdAt: "2026-05-31T06:00:00.000Z" });
		const time = container.querySelector("time");
		expect(time).not.toBeNull();
		const regen = screen.getByLabelText("Regenerate");
		expect(regen).toBeInTheDocument();
		expect(screen.getByLabelText("Copy")).toBeInTheDocument();
		expect(screen.getByLabelText("Like")).toBeInTheDocument();
		expect(screen.getByLabelText("Dislike")).toBeInTheDocument();
		// The <time> shares the footer container with the controls — the
		// in-flow fix, not a detached absolutely-positioned layer that
		// overlaps the timestamp.
		const footer = time?.parentElement ?? null;
		expect(footer).not.toBeNull();
		expect(footer).toContainElement(regen);
	});

	it("renders controls even when the message has no usable timestamp", () => {
		const { container } = setup({});
		expect(container.querySelector("time")).toBeNull();
		expect(screen.getByLabelText("Regenerate")).toBeInTheDocument();
	});

	it("hides both the timestamp and the controls while generating", () => {
		const { container } = setup(
			{ createdAt: "2026-05-31T06:00:00.000Z" },
			{ isGenerating: true },
		);
		expect(container.querySelector("time")).toBeNull();
		expect(screen.queryByLabelText("Regenerate")).not.toBeInTheDocument();
	});

	it("keeps controls visible without hover for the current message", () => {
		setup(
			{ createdAt: "2026-05-31T06:00:00.000Z" },
			{ isCurrentMessage: true },
		);
		const wrapper = screen.getByLabelText("Regenerate").parentElement;
		expect(wrapper?.className).toContain("opacity-100");
		expect(wrapper?.className).not.toContain("opacity-0");
	});

	it("hover/focus-reveals controls for non-current messages", () => {
		setup(
			{ createdAt: "2026-05-31T06:00:00.000Z" },
			{ isCurrentMessage: false },
		);
		const wrapper = screen.getByLabelText("Regenerate").parentElement;
		expect(wrapper?.className).toContain("opacity-0");
		expect(wrapper?.className).toContain("group-hover/message:opacity-100");
		expect(wrapper?.className).toContain(
			"group-focus-within/message:opacity-100",
		);
		// Touch devices (no hover) still get always-on controls.
		expect(wrapper?.className).toContain("max-md:opacity-100");
	});
});
