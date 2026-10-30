import {
	act,
	fireEvent,
	render as rtlRender,
	screen,
} from "@testing-library/react";
import * as React from "react";
import { CopilotChatSessionProvider } from "../CopilotChatSessionProvider";

// Every component under test reads its CopilotKit chat state from
// `<CopilotChatSessionProvider>` (one `useCopilotChatInternal()` per surface —
// see the provider's doc-comment and Fizzy #2389), so each render mounts the
// real provider over this file's mocked `useCopilotChatInternal`.
function render(ui: Parameters<typeof rtlRender>[0]) {
	return rtlRender(ui, { wrapper: CopilotChatSessionProvider });
}

import { beforeEach, describe, expect, it, vi } from "vitest";

const renderCounts = vi.hoisted(() => ({
	markdown: vi.fn(),
	timestamp: vi.fn(),
	userBody: vi.fn(),
}));

import { AssistantRunContext } from "../AssistantRunContext";
import {
	selectAgentTurn,
	selectExcludedTurnIds,
} from "../assistant-transcript";
import { CopilotAssistantMessage } from "../CopilotAssistantMessage";
import { CopilotReplyRatingContext } from "../CopilotReplyRatingContext";
import { CopilotUserMessage } from "../CopilotUserMessage";

vi.mock("../formatMessageTimestamp", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../formatMessageTimestamp")>();
	return {
		...actual,
		formatMessageTimestamp: (
			source: Parameters<typeof actual.formatMessageTimestamp>[0],
		) => {
			renderCounts.timestamp(source);
			return actual.formatMessageTimestamp(source);
		},
	};
});
// Only the memoized user-row body reads the registry, so this counts its renders.
vi.mock("../AttachmentRegistry", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../AttachmentRegistry")>();
	return {
		...actual,
		useAttachmentRegistry: () => {
			renderCounts.userBody();
			return actual.useAttachmentRegistry();
		},
	};
});
const ImageRenderer = () => null;
// Mock CopilotKit hooks
vi.mock("@copilotkit/react-core", () => ({
	useCopilotChatInternal: vi.fn(),
	// Mirror the installed useCoAgent run-start merge for the fail-before check.
	useCoAgent: () => {
		React.useEffect(() => {
			const subscription = fake.agent.subscribe({
				onRunInitialized: (args: { state: object }) => {
					fake.agent.setState({ ...fake.agent.state, ...args.state });
				},
			} as never);
			return () => subscription.unsubscribe();
		}, []);
		return { state: fake.agent.state };
	},
}));
vi.mock("@copilotkit/react-ui", () => ({
	Markdown: ({ content }: { content: string }) => {
		renderCounts.markdown(content);
		return <div data-testid="markdown">{content}</div>;
	},
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
vi.mock("../ReasoningCollapsible", async (importOriginal) => ({
	...(await importOriginal<typeof import("../ReasoningCollapsible")>()),
	ReasoningCollapsible: ({
		text,
		durationMs,
		toolCalls,
		inProgress,
	}: {
		text: string;
		inProgress?: boolean;
		durationMs?: number;
		toolCalls?: Array<{ id: string; name: string; status: string }>;
	}) => (
		<div
			data-testid="reasoning-collapsible"
			data-active={String(!!inProgress)}
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

import { useCopilotChatInternal } from "@copilotkit/react-core";

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

const fake = vi.hoisted(() => {
	const handlers = new Set<{
		onStateChanged?: () => void;
		onMessagesChanged?: () => void;
		onRunInitialized?: (args: { state: object }) => void;
	}>();
	const agent = {
		state: {} as Record<string, unknown>,
		messages: [] as unknown[],
		setState: vi.fn(),
		subscribe: vi.fn((handler: { onStateChanged?: () => void }) => {
			handlers.add(handler);
			return { unsubscribe: () => handlers.delete(handler) };
		}),
	};
	const agents: Record<string, unknown> = {
		project_document_generator: agent,
	};
	// Mirrors CopilotKitCore.getAgent: warns when the agent is missing and
	// the runtime is not still connecting.
	const getAgent = vi.fn((id: string) => {
		if (id in agents) {
			return agents[id];
		}
		console.warn(`Agent ${id} not found`);
		return undefined;
	});
	return { agent, agents, handlers, getAgent };
});
vi.mock("@copilotkit/react-core/v2/context", () => ({
	useCopilotKit: () => ({
		copilotkit: {
			agents: fake.agents,
			getAgent: fake.getAgent,
			subscribe: () => ({ unsubscribe: () => {} }),
		},
	}),
}));

describe("assistant row read-only agent subscription", () => {
	it("adds no run-start writes and updates reasoning and tools from state changes", () => {
		vi.mocked(useCopilotChatInternal).mockReturnValue({
			visibleMessages: [
				{ id: "u1", role: "user" },
				{ id: "a1", role: "assistant" },
			],
		} as never);
		fake.agent.messages = [
			{ id: "u1", role: "user" },
			{ id: "a1", role: "assistant" },
		];
		render(
			<>
				<CopilotAssistantMessage {...baseProps} />
				<CopilotAssistantMessage {...baseProps} />
			</>,
		);
		act(() => {
			for (const handler of fake.handlers) {
				handler.onRunInitialized?.({ state: { document: "existing" } });
			}
		});
		expect(fake.agent.setState).not.toHaveBeenCalled();
		act(() => {
			fake.agent.state = {
				messages: [
					{ id: "u1", type: "human" },
					{ id: "a1", type: "ai" },
				],
				reasoningByTurn: {
					1: { text: "Updated reasoning", durationMs: 12 },
				},
				toolCallsByTurn: {
					1: [{ id: "t1", name: "search", status: "completed" }],
				},
			};
			for (const handler of fake.handlers) {
				handler.onStateChanged?.();
			}
		});
		expect(screen.getAllByTestId("reasoning-collapsible")).toHaveLength(2);
		for (const row of screen.getAllByTestId("reasoning-collapsible")) {
			expect(row.textContent).toContain("Updated reasoning");
			expect(row.getAttribute("data-tool-count")).toBe("1");
		}
		expect(fake.agent.setState).not.toHaveBeenCalled();
	});
	it("renders safely with an unregistered agent, without per-render warnings", () => {
		delete fake.agents.project_document_generator;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(useCopilotChatInternal).mockReturnValue({
			visibleMessages: [],
		} as never);
		render(<CopilotAssistantMessage {...baseProps} />);
		expect(screen.queryByTestId("reasoning-collapsible")).toBeNull();
		expect(warn).not.toHaveBeenCalledWith(
			expect.stringContaining("not found"),
		);
		warn.mockRestore();
	});
});

describe("row render isolation", () => {
	it("renders only the changed body when cloned messages, callbacks and session change", () => {
		fake.agents.project_document_generator = fake.agent;
		fake.agent.state = {
			messages: fake.agent.messages,
		};
		const list = (last: string) => (
			<>
				{Array.from({ length: 8 }, (_, i) => (
					<React.Fragment key={i}>
						<CopilotUserMessage
							message={{
								id: `u${i}`,
								role: "user",
								content: `user ${i}`,
							}}
							ImageRenderer={ImageRenderer}
						/>
						<CopilotAssistantMessage
							{...baseProps}
							message={{
								id: `a${i}`,
								role: "assistant",
								content: i === 7 ? last : `reply ${i}`,
							}}
							messages={
								Array.from({ length: 8 }, (_, j) => [
									{
										id: `u${j}`,
										role: "user",
										content: `user ${j}`,
									},
									{
										id: `a${j}`,
										role: "assistant",
										content: j === 7 ? last : `reply ${j}`,
									},
								]).flat() as any
							}
							isCurrentMessage={i === 7}
							onCopy={() => {}}
							onRegenerate={() => {}}
							onThumbsUp={() => {}}
						/>
					</React.Fragment>
				))}
			</>
		);
		vi.mocked(useCopilotChatInternal).mockReturnValue({
			messages: [],
		} as never);
		const view = render(list("initial"));
		renderCounts.markdown.mockClear();
		renderCounts.userBody.mockClear();
		vi.mocked(useCopilotChatInternal).mockReturnValue({
			messages: [],
		} as never);
		view.rerender(list("streamed"));
		expect(renderCounts.markdown.mock.calls.map(([text]) => text)).toEqual([
			"streamed",
		]);
		expect(renderCounts.userBody).not.toHaveBeenCalled();
	});
	it("ignores unrelated turns and updates only the current turn body", () => {
		fake.agent.messages = [
			{ id: "u1", role: "user" },
			{ id: "current", role: "assistant" },
		];
		fake.agents.project_document_generator = fake.agent;
		fake.agent.state = {
			messages: [
				{ id: "u1", type: "human" },
				{ id: "current", type: "ai" },
			],
			reasoningByTurn: { 1: { text: "one" } },
		};
		render(
			<>
				<CopilotAssistantMessage
					{...baseProps}
					isCurrentMessage={false}
				/>
				<CopilotAssistantMessage
					{...baseProps}
					message={{
						id: "current",
						role: "assistant",
						content: "current",
					}}
				/>
			</>,
		);
		renderCounts.markdown.mockClear();
		act(() => {
			fake.agent.state = {
				messages: fake.agent.messages,
				...fake.agent.state,
				reasoningByTurn: {
					1: { text: "one" },
					2: { text: "unrelated" },
				},
			};
			for (const handler of fake.handlers) {
				handler.onStateChanged?.();
			}
		});
		expect(renderCounts.markdown).not.toHaveBeenCalled();
		act(() => {
			fake.agent.state = {
				messages: fake.agent.messages,
				...fake.agent.state,
				reasoningByTurn: { 1: { text: "updated" } },
			};
			for (const handler of fake.handlers) {
				handler.onStateChanged?.();
			}
		});
		expect(renderCounts.markdown.mock.calls.map(([text]) => text)).toEqual([
			"current",
		]);
	});
	it("uses latest rating and regenerate callbacks after a memo bailout", () => {
		const first = vi.fn();
		const latest = vi.fn();
		const rating = {
			getVote: () => undefined,
			canRate: () => true,
			isPending: () => false,
			setMessageIds: () => {},
		};
		const ui = (callback: () => void) => (
			<CopilotReplyRatingContext.Provider value={rating}>
				<CopilotAssistantMessage
					{...baseProps}
					onThumbsUp={callback}
					onRegenerate={callback}
				/>
			</CopilotReplyRatingContext.Provider>
		);
		const view = render(ui(first));
		renderCounts.markdown.mockClear();
		view.rerender(ui(latest));
		expect(renderCounts.markdown).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Like" }));
		fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
		expect(first).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledTimes(2);
	});
});

it("updates generative UI independently of the memoized body", () => {
	const view = render(
		<CopilotAssistantMessage
			{...baseProps}
			message={{
				...baseProps.message,
				generativeUI: () => <span>old tool result</span>,
			}}
		/>,
	);
	renderCounts.markdown.mockClear();
	view.rerender(
		<CopilotAssistantMessage
			{...baseProps}
			message={{
				...baseProps.message,
				generativeUI: () => <span>new tool result</span>,
			}}
		/>,
	);
	expect(screen.getByText("new tool result")).toBeInTheDocument();
	expect(renderCounts.markdown).not.toHaveBeenCalled();
});

it("leaves historical lookups empty despite a legacy session visibleMessages field", () => {
	fake.agents.project_document_generator = fake.agent;
	fake.agent.state = {
		messages: [{ role: "user" }],
		reasoningByTurn: { 1: { text: "current only" } },
	};
	vi.mocked(useCopilotChatInternal).mockReturnValue({
		visibleMessages: [
			{ id: "u1", role: "user" },
			{ id: "a1", role: "assistant" },
		],
	} as never);
	render(<CopilotAssistantMessage {...baseProps} isCurrentMessage={false} />);
	expect(screen.queryByTestId("reasoning-collapsible")).toBeNull();
});

it.each(["assistant", "user"])(
	"refreshes the %s timestamp across a bucket boundary on an equal-content update",
	(role) => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
			fake.agents.project_document_generator = fake.agent;
			fake.agent.state = {
				messages: fake.agent.messages,
			};
			const ui = () =>
				role === "assistant" ? (
					<CopilotAssistantMessage
						{...baseProps}
						message={{
							id: "clock",
							role: "assistant",
							content: "Reply",
							createdAt: new Date("2026-10-29T12:00:00Z"),
						}}
					/>
				) : (
					<CopilotUserMessage
						message={{
							id: "clock",
							role: "user",
							content: "Prompt",
							createdAt: new Date("2026-10-29T12:00:00Z"),
						}}
						ImageRenderer={ImageRenderer}
					/>
				);
			const view = render(ui());
			expect(screen.getByText("just now")).toBeInTheDocument();
			renderCounts.markdown.mockClear();
			vi.setSystemTime(new Date("2026-10-29T12:00:20Z"));
			view.rerender(ui());
			expect(screen.getByText("just now")).toBeInTheDocument();
			expect(renderCounts.markdown).not.toHaveBeenCalled();
			vi.setSystemTime(new Date("2026-10-29T12:10:00Z"));
			view.rerender(ui());
			expect(screen.getByText("10m ago")).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	},
);

it("selects turn two from the agent thread for a non-current reply and updates on thread changes", () => {
	fake.agents.project_document_generator = fake.agent;
	fake.agent.state = {
		messages: fake.agent.messages,
		toolCallsByTurn: {
			1: [{ id: "one", name: "first", status: "completed" }],
			2: [{ id: "two", name: "second", status: "completed" }],
		},
	};
	const ui = (second: boolean) => (
		<CopilotAssistantMessage
			{...baseProps}
			isCurrentMessage={false}
			messages={
				[
					{ id: "u1", role: "user", content: "first" },
					...(second
						? [{ id: "u2", role: "user", content: "second" }]
						: []),
					{ id: "a1", role: "assistant", content: "Assistant reply" },
				] as any
			}
		/>
	);
	fake.agent.messages = [
		{ id: "u1", role: "user" },
		{ id: "u2", role: "user" },
		{ id: "a1", role: "assistant" },
	];
	fake.agent.state.messages = fake.agent.messages;
	const view = render(ui(true));
	expect(screen.getByTestId("reasoning-collapsible")).toHaveAttribute(
		"data-tool-names",
		"second:completed",
	);
	fake.agent.messages = [
		{ id: "u1", role: "user" },
		{ id: "a1", role: "assistant" },
	];
	fake.agent.state = { ...fake.agent.state, messages: fake.agent.messages };
	view.rerender(ui(false));
	expect(screen.getByTestId("reasoning-collapsible")).toHaveAttribute(
		"data-tool-names",
		"first:completed",
	);
});

it("renders one stable trace on the first assistant row and finishes frontend tools from results", () => {
	fake.agents.project_document_generator = fake.agent;
	const user = { id: "u1", role: "user", content: "draw" };
	const call = { id: "call", role: "assistant", content: "" };
	const reply = { id: "reply", role: "assistant", content: "done" };
	const result = {
		id: "result",
		role: "tool",
		toolCallId: "tc",
		content: "{}",
	};
	const messages = [
		user,
		call,
		result,
		{
			id: "confirmation-result",
			role: "tool",
			toolCallId: "confirm",
			content: "{}",
		},
		reply,
	];
	(fake.agent as any).messages = messages;
	fake.agent.state = {
		messages: fake.agent.messages,
		toolCallsByTurn: {
			1: [
				{ id: "tc", name: "create_view", status: "pending" },
				{
					id: "confirm",
					name: "write_document_local",
					status: "pending",
				},
			],
		},
	};
	const ui = (list: any[], active = true) => (
		<AssistantRunContext.Provider value={active}>
			{[call, reply]
				.filter((message) => list.some((row) => row.id === message.id))
				.map((message) => (
					<CopilotAssistantMessage
						key={message.id}
						{...baseProps}
						message={message as any}
						messages={list}
						isCurrentMessage={false}
					/>
				))}
		</AssistantRunContext.Provider>
	);
	const view = render(ui([user, call]));
	const initialTrace = screen.getByTestId("reasoning-collapsible");
	view.rerender(ui(messages));
	expect(screen.getByTestId("reasoning-collapsible")).toBe(initialTrace);
	expect(screen.getAllByTestId("reasoning-collapsible")).toHaveLength(1);
	expect(screen.getByTestId("reasoning-collapsible")).toHaveAttribute(
		"data-tool-names",
		"create_view:success,write_document_local:pending",
	);
	const first = screen.getByTestId("reasoning-collapsible");
	expect(first).toHaveAttribute("data-active", "true");
	view.rerender(
		ui(
			messages.map((m) =>
				m.id === "result" ? { ...m, content: "Error: failed" } : m,
			),
		),
	);
	expect(screen.getByTestId("reasoning-collapsible")).toBe(first);
	expect(first).toHaveAttribute(
		"data-tool-names",
		"create_view:error,write_document_local:pending",
	);
	view.rerender(ui(messages, false));
	expect(first).toHaveAttribute("data-active", "false");
});

it("does not rerender an unchanged earlier body when messages arrive", () => {
	fake.agents.project_document_generator = fake.agent;
	fake.agent.state = {
		messages: fake.agent.messages,
	};
	(fake.agent as any).messages = [
		{ id: "u1", role: "user" },
		{ id: "a1", role: "assistant" },
	];
	const ui = (tail: any[]) => (
		<CopilotAssistantMessage
			{...baseProps}
			isCurrentMessage={false}
			messages={
				[
					{ id: "u1", role: "user", content: "prompt" },
					{ id: "a1", role: "assistant", content: "Assistant reply" },
					...tail,
				] as any
			}
		/>
	);
	const view = render(ui([]));
	renderCounts.markdown.mockClear();
	for (const tail of [
		[{ id: "tool", role: "assistant", content: "" }],
		[
			{
				id: "result",
				role: "tool",
				toolCallId: "unrelated-tool",
				content: "{}",
			},
		],
		[{ id: "u2", role: "user", content: "next" }],
	]) {
		act(() => {
			fake.agent.messages = [
				{ id: "u1", role: "user" },
				{ id: "a1", role: "assistant" },
				...tail,
			];
			for (const handler of fake.handlers) {
				handler.onMessagesChanged?.();
			}
		});
		view.rerender(ui(tail));
	}
	expect(renderCounts.markdown).not.toHaveBeenCalled();
});

it.each([false, true])(
	"skips synthetic image ids with live metadata=%s",
	(withMetadata) => {
		fake.agents.project_document_generator = fake.agent;
		const messages = [
			{ id: "u1", type: "human", content: "draw" },
			{ id: "a1", type: "ai", content: "calling" },
			{
				id: "synthetic",
				type: "human",
				content: "Image(s) retrieved by tool",
				additional_kwargs: { fabricSyntheticToolImage: true },
			},
			{ id: "reply", type: "ai", content: "done" },
			{ id: "u2", type: "human", content: "next" },
			{ id: "a2", type: "ai", content: "second" },
		];
		fake.agent.messages = messages.map(
			({ id, type, content, ...metadata }) => ({
				id,
				role: type === "human" ? "user" : "assistant",
				content,
				...(withMetadata ? metadata : {}),
			}),
		);
		fake.agent.state = {
			messages,
			toolCallsByTurn: {
				1: [{ id: "tc1", name: "turn-one", status: "success" }],
				2: [{ id: "tc2", name: "turn-two", status: "success" }],
			},
		};
		const ui = (id: string) => (
			<CopilotAssistantMessage
				{...baseProps}
				message={{ id, role: "assistant", content: "reply" } as any}
				messages={fake.agent.messages as any}
				isCurrentMessage={false}
			/>
		);
		const view = render(ui("a2"));
		expect(screen.getByTestId("reasoning-collapsible")).toHaveAttribute(
			"data-tool-names",
			"turn-two:success",
		);
		renderCounts.markdown.mockClear();
		act(() => {
			fake.agent.state = {
				...fake.agent.state,
				messages: [
					...messages.map((m) => ({ ...m })),
					{ id: "later", type: "human", content: "later" },
				],
			};
			for (const handler of fake.handlers) {
				handler.onStateChanged?.();
			}
		});
		expect(renderCounts.markdown).not.toHaveBeenCalled();
		view.rerender(ui("reply"));
		expect(screen.queryByTestId("reasoning-collapsible")).toBeNull();
		view.rerender(ui("a1"));
		expect(screen.getByTestId("reasoning-collapsible")).toHaveAttribute(
			"data-tool-names",
			"turn-one:success",
		);
	},
);

it("keeps a single display trace owner across a synthetic image", () => {
	fake.agents.project_document_generator = fake.agent;
	const messages = [
		{ id: "u1", type: "human", content: "draw" },
		{ id: "a1", type: "ai", content: "calling" },
		{
			id: "image",
			type: "human",
			content: "image",
			additional_kwargs: { fabricSyntheticToolImage: true },
		},
		{ id: "reply", type: "ai", content: "done" },
	];
	fake.agent.messages = messages.map(({ id, type, content }) => ({
		id,
		role: type === "human" ? "user" : "assistant",
		content,
	}));
	fake.agent.state = {
		messages,
		reasoningByTurn: { 1: { text: "thinking" }, 2: { text: "wrong turn" } },
	};
	render(
		["a1", "reply"].map((id) => (
			<CopilotAssistantMessage
				key={id}
				{...baseProps}
				message={{ id, role: "assistant", content: "reply" } as any}
				messages={fake.agent.messages as any}
				isCurrentMessage={false}
			/>
		)),
	);
	expect(screen.getAllByTestId("reasoning-collapsible")).toHaveLength(1);
});

beforeEach(() => {
	fake.agent.messages = [];
});

it("leaves a row missing from the live transcript without a turn while active or idle", () => {
	fake.agents.project_document_generator = fake.agent;
	fake.agent.messages = [{ id: "u1", role: "user" }];
	fake.agent.state = {
		messages: fake.agent.messages,
		reasoningByTurn: { 1: { text: "pending" } },
	};
	const ui = (active: boolean) => (
		<CopilotAssistantMessage
			{...baseProps}
			messages={[{ id: "u1", role: "user", content: "draw" }] as any}
			isGenerating={active}
		/>
	);
	const view = render(ui(true));
	expect(screen.queryByTestId("reasoning-collapsible")).toBeNull();
	view.rerender(ui(false));
	expect(screen.queryByTestId("reasoning-collapsible")).toBeNull();
});

it("keeps turn-one trace on a1 while state lags behind the streaming second turn", () => {
	fake.agents.project_document_generator = fake.agent;
	fake.agent.messages = [
		{ id: "u1", role: "user" },
		{ id: "a1", role: "assistant" },
		{ id: "u2", role: "user" },
		{ id: "a2", role: "assistant" },
	];
	fake.agent.state = {
		messages: [
			{ id: "u1", type: "human" },
			{ id: "a1", type: "ai" },
		],
		toolCallsByTurn: {
			1: [{ id: "tc1", name: "turn-one", status: "success" }],
		},
	};
	expect(selectAgentTurn(fake.agent.messages, "a1")).toBe(1);
	expect(selectAgentTurn(fake.agent.messages, "a2")).toBe(2);
	render(
		["a1", "a2"].map((id) => (
			<div key={id} data-testid={`row-${id}`}>
				<CopilotAssistantMessage
					{...baseProps}
					message={{ id, role: "assistant", content: "reply" } as any}
					messages={fake.agent.messages as any}
					isCurrentMessage={id === "a2"}
					isGenerating={id === "a2"}
				/>
			</div>
		)),
	);
	expect(screen.getByTestId("row-a1")).toHaveTextContent("reply");
	expect(
		screen
			.getByTestId("row-a2")
			.querySelector('[data-testid="reasoning-collapsible"]'),
	).toBeNull();
	expect(screen.getAllByTestId("reasoning-collapsible")).toHaveLength(1);
	expect(screen.getByTestId("reasoning-collapsible")).toHaveAttribute(
		"data-tool-names",
		"turn-one:success",
	);
});

it("updates a missing row from message events without rendering an unchanged row", () => {
	fake.agents.project_document_generator = fake.agent;
	fake.agent.messages = [
		{ id: "u1", role: "user" },
		{ id: "a1", role: "assistant" },
	];
	fake.agent.state = {
		messages: [
			{ id: "u1", type: "human" },
			{ id: "a1", type: "ai" },
		],
		reasoningByTurn: {
			1: { text: "first trace" },
			2: { text: "second trace" },
		},
	};
	render(
		["a1", "a2"].map((id) => (
			<CopilotAssistantMessage
				key={id}
				{...baseProps}
				message={{ id, role: "assistant", content: id } as any}
				messages={
					[
						{ id: "u1", role: "user" },
						{ id: "a1", role: "assistant" },
						{ id: "u2", role: "user" },
						{ id: "a2", role: "assistant" },
					] as any
				}
			/>
		)),
	);
	expect(screen.getAllByTestId("reasoning-collapsible")).toHaveLength(1);
	renderCounts.markdown.mockClear();
	act(() => {
		fake.agent.messages = [
			...fake.agent.messages,
			{ id: "u2", role: "user" },
			{ id: "a2", role: "assistant" },
		];
		for (const handler of fake.handlers) {
			handler.onMessagesChanged?.();
		}
	});
	expect(screen.getAllByTestId("reasoning-collapsible")).toHaveLength(2);
	expect(screen.getByText("reasoning:second trace:none")).toBeInTheDocument();
	expect(
		renderCounts.markdown.mock.calls.map(([content]) => content),
	).toEqual(["a2"]);
	renderCounts.markdown.mockClear();
	act(() => {
		fake.agent.messages = fake.agent.messages.map((message) => ({
			...(message as object),
			content: "token",
		}));
		for (const handler of fake.handlers) {
			handler.onMessagesChanged?.();
		}
	});
	expect(renderCounts.markdown).not.toHaveBeenCalled();
});

describe("turn numbering across snapshot windows", () => {
	const stateMessages = (ids: string[]) =>
		ids.map((id) => ({ id, type: id.startsWith("u") ? "human" : "ai" }));
	const liveMessages = (ids: string[]) =>
		ids.map((id) => ({
			id,
			role: id.startsWith("u") ? "user" : "assistant",
			content: id,
		}));
	function setup(stateIds: string[], liveIds: string[], traces = true) {
		fake.agents.project_document_generator = fake.agent;
		fake.agent.messages = liveMessages(liveIds);
		fake.agent.state = {
			messages: stateMessages(stateIds),
			...(traces
				? {
						reasoningByTurn: {
							1: { text: "turn one" },
							2: { text: "turn two" },
							3: { text: "turn three" },
						},
					}
				: {}),
		};
	}
	function turn(id: string) {
		const state = fake.agent.state as { messages?: unknown[] };
		return selectAgentTurn(
			fake.agent.messages,
			id,
			selectExcludedTurnIds(state),
			state.messages,
		);
	}
	function rows(ids: string[]) {
		return render(
			ids.map((id) => (
				<CopilotAssistantMessage
					key={id}
					{...baseProps}
					message={{ id, role: "assistant", content: id } as any}
					messages={fake.agent.messages as any}
				/>
			)),
		);
	}
	it("turn start uses state plus the live tail without sharing turn one's trace", () => {
		setup(["u1", "a1"], ["u1", "a1", "u2", "a2"]);
		expect(turn("a1")).toBe(1);
		expect(turn("a2")).toBe(2);
		fake.agent.state.reasoningByTurn = { 1: { text: "turn one" } };
		rows(["a1", "a2"]);
		expect(screen.getAllByTestId("reasoning-collapsible")).toHaveLength(1);
		expect(screen.getAllByText("reasoning:turn one:none")).toHaveLength(1);
		expect(screen.queryByText("reasoning:turn two:none")).toBeNull();
	});
	it("reload without replay uses the whole-thread mid-run state", () => {
		setup(["u1", "a1", "u2", "a2", "u3"], ["u3", "a3"]);
		expect(turn("a3")).toBe(3);
		rows(["a3"]);
		expect(
			screen.getByText("reasoning:turn three:none"),
		).toBeInTheDocument();
	});
	it("reload before a state snapshot harmlessly has turn one and no trace", () => {
		setup([], ["u3", "a3"], false);
		expect(turn("a3")).toBe(1);
		rows(["a3"]);
		// No trace exists yet, so the provisional local count displays no stale trace.
		expect(screen.queryByTestId("reasoning-collapsible")).toBeNull();
	});
	it("reload with stale state adds the unshared live turn", () => {
		setup(["u1", "a1", "u2", "a2"], ["u3", "a3"]);
		expect(turn("a3")).toBe(3);
		rows(["a3"]);
		expect(
			screen.getByText("reasoning:turn three:none"),
		).toBeInTheDocument();
	});
	it("synthetic images flagged only in state do not split known or tail rows", () => {
		setup(["u1", "a1", "uimage", "a2"], ["uimage", "a2", "u3", "a3"]);
		(fake.agent.state.messages as any[])[2].additional_kwargs = {
			fabricSyntheticToolImage: true,
		};
		expect(turn("a1")).toBe(1);
		expect(turn("a2")).toBe(1);
		expect(turn("a3")).toBe(2);
		rows(["a2", "a3"]);
		expect(screen.getByText("reasoning:turn one:none")).toBeInTheDocument();
		expect(screen.getByText("reasoning:turn two:none")).toBeInTheDocument();
	});
	it("rows missing from both lists have no trace", () => {
		setup(["u1", "a1"], ["u3", "a3"]);
		expect(turn("missing")).toBeNull();
		rows(["missing"]);
		expect(screen.queryByTestId("reasoning-collapsible")).toBeNull();
	});
	it("state events correct the turn before messages replay, and run end preserves it", () => {
		setup([], ["u3", "a3"], false);
		rows(["a3"]);
		act(() => {
			fake.agent.state = {
				messages: stateMessages(["u1", "a1", "u2", "a2", "u3"]),
				reasoningByTurn: { 3: { text: "turn three" } },
			};
			for (const handler of fake.handlers) {
				handler.onStateChanged?.();
			}
		});
		expect(
			screen.getByText("reasoning:turn three:none"),
		).toBeInTheDocument();
		act(() => {
			fake.agent.messages = liveMessages([
				"u1",
				"a1",
				"u2",
				"a2",
				"u3",
				"a3",
			]);
			fake.agent.state = {
				...fake.agent.state,
				messages: stateMessages(["u1", "a1", "u2", "a2", "u3", "a3"]),
			};
			for (const handler of fake.handlers) {
				handler.onStateChanged?.();
				handler.onMessagesChanged?.();
			}
		});
		expect(
			screen.getByText("reasoning:turn three:none"),
		).toBeInTheDocument();
	});
	it("invalidates a cached live array after addMessage pushes a user", () => {
		setup(["u1", "a1"], ["u1", "a1"]);
		rows(["a1"]);
		const messages = fake.agent.messages;
		expect(selectAgentTurn(messages, "u2")).toBeNull();
		messages.push({ id: "u2", role: "user" });
		expect(selectAgentTurn(messages, "u2")).toBe(2);
	});
});

for (const live of [false, true]) {
	it(`restores saved display turns once, with live priority: ${live}`, () => {
		fake.agents.project_document_generator = fake.agent;
		const tool = {
			id: "saved-tool",
			name: "saved-search",
			status: "success",
		};
		const messages = [
			{ id: "su1", role: "user", content: "one" },
			{ id: "sa1", role: "assistant", content: "first" },
			{
				id: "sa1b",
				role: "assistant",
				content: "second",
				metadata: { fabricAssistantToolTrace: [tool] },
				reasoningText: "saved reason",
			},
			{ id: "su2", role: "user", content: "two" },
			{
				id: "sa2",
				role: "assistant",
				content: "tools only",
				metadata: { fabricAssistantToolTrace: [tool] },
			},
			{ id: "su3", role: "user", content: "three" },
			{
				id: "sa3",
				role: "assistant",
				content: "current",
				metadata: { fabricAssistantToolTrace: [tool] },
				reasoningText: "old reason",
			},
			{ id: "su4", role: "user", content: "four" },
			{ id: "sa4", role: "assistant", content: "no trace" },
		];
		fake.agent.messages = live ? messages : [];
		fake.agent.state = live
			? {
					messages,
					reasoningByTurn: { 3: { text: "live reason" } },
					toolCallsByTurn: { 3: [{ ...tool, name: "live-search" }] },
				}
			: {};
		render(
			messages
				.filter((m) => m.role === "assistant")
				.map((m) => (
					<div key={m.id} data-testid={`saved-row-${m.id}`}>
						<CopilotAssistantMessage
							{...baseProps}
							message={m as any}
							messages={messages as any}
						/>
					</div>
				)),
		);
		const traces = screen.getAllByTestId("reasoning-collapsible");
		expect(traces).toHaveLength(3);
		expect(
			screen
				.getByTestId("saved-row-sa1")
				.querySelector('[data-testid="reasoning-collapsible"]'),
		).not.toBeNull();
		expect(
			screen
				.getByTestId("saved-row-sa1b")
				.querySelector('[data-testid="reasoning-collapsible"]'),
		).toBeNull();
		expect(
			screen
				.getByTestId("saved-row-sa4")
				.querySelector('[data-testid="reasoning-collapsible"]'),
		).toBeNull();
		expect(traces[0].textContent).toContain("saved reason");
		expect(traces[1].textContent).toBe("reasoning::none");
		expect(traces[2].textContent).toContain(
			live ? "live reason" : "old reason",
		);
		expect(traces[2].getAttribute("data-tool-names")).toContain(
			live ? "live-search" : "saved-search",
		);
	});
}

for (const status of ["success", "error"] as const) {
	for (const laterTurn of [false, true]) {
		it(`uses the resolved saved confirmation trace: ${status}, later turn ${laterTurn}`, () => {
			fake.agents.project_document_generator = fake.agent;
			const tool = {
				id: "confirmation",
				name: "apply_document_patches",
				status: "pending",
			};
			const history = [
				{ id: "cu1", role: "user", content: "edit" },
				{
					id: "ca1",
					role: "assistant",
					content: "Changes ready for review.",
					metadata: { fabricAssistantToolTrace: [tool] },
				},
				{
					id: "ca2",
					role: "assistant",
					content: "Decision recorded.",
					metadata: {
						fabricAssistantToolTrace: [{ ...tool, status }],
					},
				},
			];
			const next = [
				{ id: "cu2", role: "user", content: "next" },
				{ id: "ca3", role: "assistant", content: "next reply" },
			];
			const messages = laterTurn ? [...history, ...next] : history;
			fake.agent.messages = laterTurn ? messages : [];
			fake.agent.state = laterTurn
				? {
						messages,
						toolCallsByTurn: {
							2: [
								{
									id: "next-tool",
									name: "search",
									status: "success",
								},
							],
						},
					}
				: {};
			render(
				<div>
					{messages
						.filter((m) => m.role === "assistant")
						.map((m) => (
							<div
								key={m.id}
								data-testid={`confirmation-row-${m.id}`}
							>
								<CopilotAssistantMessage
									{...baseProps}
									message={m as any}
									messages={messages as any}
								/>
							</div>
						))}
				</div>,
			);
			const owner = screen
				.getByTestId("confirmation-row-ca1")
				.querySelector('[data-testid="reasoning-collapsible"]');
			expect(owner?.getAttribute("data-tool-names")).toBe(
				`apply_document_patches:${status}`,
			);
			expect(owner?.getAttribute("data-tool-count")).toBe("1");
			expect(
				screen
					.getByTestId("confirmation-row-ca2")
					.querySelector('[data-testid="reasoning-collapsible"]'),
			).toBeNull();
		});
	}
}

it("reload history cannot borrow the new run's trace", () => {
	fake.agents.project_document_generator = fake.agent;
	const history = [
		{ id: "hu1", role: "user", content: "one" },
		{
			id: "ha1",
			role: "assistant",
			content: "first",
			reasoningText: "saved one",
		},
		{ id: "hu2", role: "user", content: "two" },
		{
			id: "ha2",
			role: "assistant",
			content: "second",
			reasoningText: "saved two",
		},
	];
	const live = [
		{ id: "u3", role: "user", content: "three" },
		{ id: "a3", role: "assistant", content: "third" },
	];
	fake.agent.messages = live;
	fake.agent.state = {
		messages: live,
		reasoningByTurn: { 1: { text: "new run" } },
	};
	const display = [...history, ...live];
	// A display transcript can contain history before the last shared live row.
	expect(selectAgentTurn(display, "ha1", new Set(), live)).toBeNull();
	expect(selectAgentTurn(display, "ha2", new Set(), live)).toBeNull();
	render(
		display
			.filter((m) => m.role === "assistant")
			.map((message) => (
				<CopilotAssistantMessage
					key={message.id}
					{...baseProps}
					message={message as any}
					messages={display as any}
				/>
			)),
	);
	expect(screen.getAllByText("reasoning:new run:none")).toHaveLength(1);
	expect(screen.getByText("reasoning:saved one:none")).toBeInTheDocument();
	expect(screen.getByText("reasoning:saved two:none")).toBeInTheDocument();
});
