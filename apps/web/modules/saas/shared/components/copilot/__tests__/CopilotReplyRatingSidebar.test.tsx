import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	rate: vi.fn(),
	clear: vi.fn(),
}));
const history = vi.hoisted(() => [
	{ id: "example-restored", role: "assistant", content: "Restored reply" },
]);
const messages = vi.hoisted(() => [
	{ id: "example-live", role: "assistant", content: "Live reply" },
	{
		id: "example-tool",
		role: "assistant",
		content: "",
		toolCalls: [{ id: "example-call" }],
	},
]);
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { ai: { feedback: mocks } },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		ai: {
			feedback: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["feedback", input],
						queryFn: () => mocks.list(input),
					}),
				},
			},
		},
	},
}));
vi.mock("../CopilotChatSessionProvider", () => ({
	useCopilotChatSession: () => ({
		messages,
		visibleMessages: messages,
		interrupt: null,
	}),
}));
vi.mock("@saas/projects/components/copilot/HydratedMessagesContext", () => ({
	useHydratedMessages: () => ({
		historicalMessages: history,
		historicalIdSet: new Set(history.map((message) => message.id)),
	}),
}));
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({ state: {} }),
}));
vi.mock("@copilotkit/react-ui", () => {
	const RenderMessage = ({
		AssistantMessage,
		...props
	}: {
		AssistantMessage: ComponentType<Record<string, unknown>>;
	}) => (
		<AssistantMessage {...props} isLoading={false} isGenerating={false} />
	);
	return {
		Markdown: ({ content }: { content: string }) => <div>{content}</div>,
		useChatContext: () => ({
			labels: {
				initial: "Welcome",
				thumbsUp: "Helpful",
				thumbsDown: "Unhelpful",
			},
			icons: {},
		}),
		CopilotSidebar: ({
			Messages,
			AssistantMessage,
			onThumbsUp,
			onThumbsDown,
		}: {
			Messages: ComponentType<Record<string, unknown>>;
			AssistantMessage: ComponentType<Record<string, unknown>>;
			onThumbsUp: unknown;
			onThumbsDown: unknown;
		}) => (
			<Messages
				inProgress={false}
				AssistantMessage={AssistantMessage}
				onThumbsUp={onThumbsUp}
				onThumbsDown={onThumbsDown}
				RenderMessage={RenderMessage}
			/>
		),
	};
});
vi.mock("../../../../../components/ai-elements/McpAppFrame", () => ({
	McpAppFrame: () => null,
}));
vi.mock("../ReasoningCollapsible", () => ({
	ReasoningCollapsible: () => null,
}));

import { CustomMessages } from "@saas/projects/components/copilot/CustomMessages";
import { CopilotAssistantMessage } from "../CopilotAssistantMessage";
import { CopilotReplyRatingSidebar } from "../CopilotReplyRatingSidebar";

beforeEach(() => {
	vi.resetAllMocks();
	history.splice(0, history.length, {
		id: "example-restored",
		role: "assistant",
		content: "Restored reply",
	});
	messages.splice(0, messages.length, {
		id: "example-live",
		role: "assistant",
		content: "Live reply",
	});
	mocks.list.mockResolvedValue({ outcomes: {} });
	mocks.rate.mockResolvedValue({ outcome: "RATED_UP" });
});
function mountSidebar(enabled = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const ui = () => (
		<QueryClientProvider client={client}>
			<CopilotReplyRatingSidebar
				featureKey="publishing-suite"
				projectId="example-project"
				enabled={enabled}
				Messages={CustomMessages}
				AssistantMessage={CopilotAssistantMessage}
			/>
		</QueryClientProvider>
	);
	const mounted = render(ui());
	return { ...mounted, refresh: () => mounted.rerender(ui()), client };
}
// The sidebar adapter stands in for CopilotKit's prop forwarding; Fabric's
// message list, renderer, rating context, hook and QueryClient run together.
describe("saved chat reply ratings", () => {
	it("restores votes on saved and live ids, excludes greetings/tool siblings and toggles through the sidebar", async () => {
		mocks.list.mockResolvedValue({
			outcomes: { "example-restored": "RATED_UP" },
		});
		mocks.clear.mockResolvedValue({ cleared: true });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<CopilotReplyRatingSidebar
					featureKey="publishing-suite"
					projectId="example-project"
					enabled={true}
					Messages={CustomMessages}
					AssistantMessage={CopilotAssistantMessage}
				/>
			</QueryClientProvider>,
		);
		await waitFor(() =>
			expect(
				screen.getAllByRole("button", { name: "Helpful" }),
			).toHaveLength(2),
		);
		await waitFor(() =>
			expect(
				screen.getAllByRole("button", { name: "Helpful" })[0],
			).toHaveAttribute("aria-pressed", "true"),
		);
		expect(mocks.list).toHaveBeenCalledWith({
			featureKey: "publishing-suite",
			subjectType: "copilot-message",
			subjectIds: ["example-restored", "example-live"],
			projectId: "example-project",
		});
		fireEvent.click(screen.getAllByRole("button", { name: "Helpful" })[0]);
		await waitFor(() =>
			expect(mocks.clear).toHaveBeenCalledWith({
				featureKey: "publishing-suite",
				subjectType: "copilot-message",
				subjectId: "example-restored",
				projectId: "example-project",
			}),
		);
		await waitFor(() =>
			expect(
				screen.getAllByRole("button", { name: "Helpful" })[0],
			).toHaveAttribute("aria-pressed", "false"),
		);
		expect(mocks.rate).not.toHaveBeenCalled();
	});
	it("disables ratings and skips list when conversation persistence is off", async () => {
		mountSidebar(false);
		expect(await screen.findByText("Live reply")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Helpful" }),
		).not.toBeInTheDocument();
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it("keeps an earlier reply's pressed state while a new reply is loading", async () => {
		mocks.list.mockResolvedValueOnce({
			outcomes: { "example-live": "RATED_UP" },
		});
		const mounted = mountSidebar();
		const replyElement = () =>
			screen
				.getByText("Live reply")
				.closest(".copilotKitAssistantMessage") as HTMLElement;
		await waitFor(() =>
			expect(
				within(replyElement()).getByRole("button", { name: "Helpful" }),
			).toHaveAttribute("aria-pressed", "true"),
		);
		let finish!: (value: unknown) => void;
		mocks.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		messages.push({
			id: "example-new-reply",
			role: "assistant",
			content: "New reply",
		});
		mounted.refresh();
		await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
		expect(
			within(replyElement()).getByRole("button", { name: "Helpful" }),
		).toHaveAttribute("aria-pressed", "true");
		expect(
			within(replyElement()).getByRole("button", { name: "Helpful" }),
		).not.toBeDisabled();
		finish({ outcomes: {} });
	});
	it("restores a vote cast on a live reply after a fresh mount loads that id from history", async () => {
		history.length = 0;
		const savedVotes: Record<string, string> = {};
		mocks.list.mockImplementation(async () => ({
			outcomes: { ...savedVotes },
		}));
		mocks.rate.mockImplementation(
			async (input: { subjectId: string; outcome: string }) => {
				savedVotes[input.subjectId] = input.outcome;
				return { outcome: input.outcome };
			},
		);
		const live = mountSidebar();
		const up = await screen.findByRole("button", { name: "Helpful" });
		fireEvent.click(up);
		await waitFor(() =>
			expect(mocks.rate).toHaveBeenCalledWith(
				expect.objectContaining({
					subjectId: "example-live",
					outcome: "RATED_UP",
				}),
			),
		);
		await waitFor(() =>
			expect(up).toHaveAttribute("aria-disabled", "false"),
		);
		live.unmount();
		live.client.clear();
		history.push({
			id: "example-live",
			role: "assistant",
			content: "Live reply",
		});
		messages.length = 0;
		mountSidebar();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Helpful" }),
			).toHaveAttribute("aria-pressed", "true"),
		);
		expect(mocks.list).toHaveBeenLastCalledWith(
			expect.objectContaining({ subjectIds: ["example-live"] }),
		);
	});
	it("keeps keyboard focus while a rating request is pending", async () => {
		let finish!: (value: unknown) => void;
		mocks.rate.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		mountSidebar();
		const up = (
			await screen.findAllByRole("button", { name: "Helpful" })
		)[0];
		up.focus();
		fireEvent.click(up);
		await waitFor(() =>
			expect(up).toHaveAttribute("aria-disabled", "true"),
		);
		expect(up).not.toBeDisabled();
		expect(up).toHaveFocus();
		fireEvent.click(up);
		expect(mocks.rate).toHaveBeenCalledTimes(1);
		finish({ outcome: "RATED_UP" });
		await waitFor(() =>
			expect(up).toHaveAttribute("aria-disabled", "false"),
		);
	});
});
