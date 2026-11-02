import {
	applyDataAnalystEvent,
	EMPTY_DATA_ANALYST_TURN,
} from "@saas/agents/lib/data-analyst-runtime-events";
import { DataAnalystEventTranslator } from "@saas/agents/runtime/data-analyst-events";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_ANALYST_WIRE } from "@/__tests__/agents/runtime/_helpers/data-analyst-wire";
import { DataAnalystChat } from "../DataAnalystChat";

const m = vi.hoisted(() => ({
	hook: vi.fn(),
	action: vi.fn(),
	actionClick: vi.fn(),
	send: vi.fn(),
	reset: vi.fn(),
	stop: vi.fn(),
}));
vi.mock("@saas/agents/hooks/useDataAnalystChat", () => ({
	useDataAnalystChat: m.hook,
}));
vi.mock(
	"@saas/shared/components/copilot/use-chatgpt-plan-spent-action",
	() => ({ useChatgptPlanSpentAction: () => m.action }),
);
vi.mock("@saas/agents/components/FabricChat/shared/ChatInput", () => ({
	ChatInput: ({ onSend }: { onSend: () => void }) => (
		<button type="button" onClick={onSend}>
			Send
		</button>
	),
}));
vi.mock("@saas/agents/components/FabricChat/shared/ChatWelcome", () => ({
	ChatWelcome: ({
		composer,
		title,
	}: {
		composer: ReactNode;
		title: string;
	}) => (
		<div>
			<h1>{title}</h1>
			{composer}
		</div>
	),
}));
vi.mock("@/components/ai-elements/conversation", () => ({
	Conversation: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	ConversationContent: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
}));
beforeEach(() => {
	vi.clearAllMocks();
	m.hook.mockReturnValue({
		messages: [],
		running: false,
		send: m.send,
		reset: m.reset,
		stop: m.stop,
	});
	m.action.mockReturnValue({
		label: "Use organization billing",
		onClick: m.actionClick,
	});
});

describe("DataAnalystChat", () => {
	it("keeps the welcome and composer available before any answer or chart", () => {
		render(<DataAnalystChat organizationId="org-example-1" />);
		expect(
			screen.getByRole("heading", { name: "Data analyst" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "View fullscreen" }),
		).toBeNull();
		expect(m.send).not.toHaveBeenCalled();
	});
	it("renders real translated chart events through ToolCallList and ChartCard", async () => {
		const translator = new DataAnalystEventTranslator();
		const turn = DATA_ANALYST_WIRE.flatMap((event) =>
			translator.translate(event),
		).reduce(applyDataAnalystEvent, EMPTY_DATA_ANALYST_TURN);
		m.hook.mockReturnValue({
			messages: [{ id: "answer", role: "assistant", turn }],
			running: false,
			send: m.send,
			reset: m.reset,
			stop: m.stop,
		});
		render(<DataAnalystChat organizationId="org-example-1" />);
		expect(
			await screen.findByText("Here is the chart. Done."),
		).toBeInTheDocument();
		expect(
			(await screen.findAllByText("Example chart")).length,
		).toBeGreaterThan(0);
		fireEvent.click(
			await screen.findByRole("button", { name: "View fullscreen" }),
		);
		const dialog = await screen.findByRole("dialog", {
			name: "Example chart",
		});
		expect(
			within(dialog).getByRole("heading", { name: "Example chart" }),
		).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(
			screen.getByText("Here is the chart. Done."),
		).toBeInTheDocument();
	});
	it("does not render remote images from a reply", async () => {
		m.hook.mockReturnValue({
			messages: [
				{
					id: "answer",
					role: "assistant",
					turn: {
						...EMPTY_DATA_ANALYST_TURN,
						status: "finished",
						text: "Answer loaded\n\n![x](https://example.com/p?d=1)",
					},
				},
			],
			running: false,
			send: m.send,
			reset: m.reset,
			stop: m.stop,
		});
		const { container } = render(
			<DataAnalystChat organizationId="org-example-1" />,
		);
		expect(await screen.findByText("Answer loaded")).toBeInTheDocument();
		expect(container.querySelector("img")).toBeNull();
	});
	it("offers the shared plan action for the chat's organization", () => {
		const planSpent = {
			title: "Plan spent",
			description: "Wait or use billing",
			planApiBillingActionable: true,
		};
		m.hook.mockReturnValue({
			messages: [
				{
					id: "answer",
					role: "assistant",
					turn: {
						...EMPTY_DATA_ANALYST_TURN,
						status: "failed",
						error: "Wait or use billing",
						planSpent,
					},
				},
			],
			running: false,
			send: m.send,
			reset: m.reset,
			stop: m.stop,
		});
		render(<DataAnalystChat organizationId="org-example-1" />);
		expect(m.action).toHaveBeenCalledWith(planSpent, "org-example-1");
		fireEvent.click(
			screen.getByRole("button", { name: "Use organization billing" }),
		);
		expect(m.actionClick).toHaveBeenCalledTimes(1);
	});
});
