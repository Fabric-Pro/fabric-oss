import {
	applyDataAnalystEvent,
	EMPTY_DATA_ANALYST_TURN,
} from "@saas/agents/lib/data-analyst-runtime-events";
import { DataAnalystEventTranslator } from "@saas/agents/runtime/data-analyst-events";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_ANALYST_WIRE } from "@/__tests__/agents/runtime/_helpers/data-analyst-wire";
import { DataAnalystChat } from "../DataAnalystChat";

const m = vi.hoisted(() => ({
	hook: vi.fn(),
	action: vi.fn(),
	actionClick: vi.fn(),
	send: vi.fn(),
	reset: vi.fn(),
	stop: vi.fn(),
	resultLoad: vi.fn(),
	resultRender: vi.fn(),
	deferResult: false,
	resultReady: Promise.withResolvers<void>(),
}));
vi.mock("../DataAnalystAssistantTurn", async (original) => {
	m.resultLoad();
	const { DataAnalystAssistantTurn } =
		await original<typeof import("../DataAnalystAssistantTurn")>();
	return {
		DataAnalystAssistantTurn: (
			props: Parameters<typeof DataAnalystAssistantTurn>[0],
		) => {
			m.resultRender();
			if (m.deferResult) {
				throw m.resultReady.promise;
			}
			return <DataAnalystAssistantTurn {...props} />;
		},
	};
});
vi.mock("@saas/agents/components/FabricChat/shared/AnsweredByModel", () => ({
	AnsweredByModel: ({ model }: { model?: { id: string } }) =>
		model ? <span>Answered by {model.id}</span> : null,
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
	m.deferResult = false;
	m.resultReady = Promise.withResolvers<void>();
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
afterEach(() => {
	m.deferResult = false;
	m.resultReady.resolve();
});

describe("DataAnalystChat", () => {
	it("shows pending then stopped without loading assistant results", async () => {
		m.deferResult = true;
		m.hook.mockReturnValue({
			messages: [
				{
					id: "answer",
					role: "assistant",
					turn: EMPTY_DATA_ANALYST_TURN,
				},
			],
			running: true,
			send: m.send,
			reset: m.reset,
			stop: m.stop,
		});
		const { rerender } = render(
			<DataAnalystChat organizationId="example-org" />,
		);
		expect(screen.getByText("Analyzing…")).toBeInTheDocument();
		await act(async () => {});
		m.hook.mockReturnValue({
			messages: [
				{
					id: "answer",
					role: "assistant",
					turn: { ...EMPTY_DATA_ANALYST_TURN, status: "stopped" },
				},
			],
			running: false,
			send: m.send,
			reset: m.reset,
			stop: m.stop,
		});
		rerender(<DataAnalystChat organizationId="example-org" />);
		expect(screen.getByText("Stopped")).toBeInTheDocument();
		expect(screen.queryByText("Analyzing…")).toBeNull();
		expect(m.resultLoad).not.toHaveBeenCalled();
		expect(m.resultRender).not.toHaveBeenCalled();
	});
	it("shows a runtime-loader error without waiting for assistant results", () => {
		m.deferResult = true;
		m.hook.mockReturnValue({
			messages: [
				{
					id: "answer",
					role: "assistant",
					turn: {
						...EMPTY_DATA_ANALYST_TURN,
						status: "failed",
						error: "The analysis could not load. Please try again.",
					},
				},
			],
			running: false,
			send: m.send,
			reset: m.reset,
			stop: m.stop,
		});
		render(<DataAnalystChat organizationId="example-org" />);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"The analysis could not load. Please try again.",
		);
		expect(screen.queryByText("Analyzing…")).toBeNull();
		expect(m.resultLoad).not.toHaveBeenCalled();
		expect(m.resultRender).not.toHaveBeenCalled();
	});
	it("keeps a model-only empty turn unlabeled without loading results", () => {
		m.hook.mockReturnValue({
			messages: [
				{
					id: "answer",
					role: "assistant",
					turn: {
						...EMPTY_DATA_ANALYST_TURN,
						status: "finished",
						model: { id: "example-served", viaPlan: false },
					},
				},
			],
			running: false,
			send: m.send,
			reset: m.reset,
			stop: m.stop,
		});
		render(<DataAnalystChat organizationId="example-org" />);
		expect(screen.queryByText("Answered by example-served")).toBeNull();
		expect(m.resultLoad).not.toHaveBeenCalled();
		expect(m.resultRender).not.toHaveBeenCalled();
	});
	it("shows an answer's explicit model while keeping old answers unlabeled", async () => {
		m.hook.mockReturnValue({
			messages: [
				{
					id: "answer",
					role: "assistant",
					turn: {
						...EMPTY_DATA_ANALYST_TURN,
						text: "Answer",
						model: { id: "example-served", viaPlan: false },
					},
				},
				{
					id: "old",
					role: "assistant",
					turn: { ...EMPTY_DATA_ANALYST_TURN, text: "Old answer" },
				},
			],
			running: false,
			send: m.send,
			reset: m.reset,
			stop: m.stop,
		});
		render(<DataAnalystChat organizationId="example-org" />);
		await act(async () => {
			await import("../DataAnalystAssistantTurn");
			await vi.dynamicImportSettled();
		});
		expect(
			await screen.findAllByText("Answered by example-served"),
		).toHaveLength(1);
		expect(screen.getByText("Old answer")).toBeInTheDocument();
	});
	it("keeps a partial answer and Stop state visible while results load", async () => {
		m.deferResult = true;
		const turn = {
			...EMPTY_DATA_ANALYST_TURN,
			text: "Partial answer",
			model: { id: "example-served", viaPlan: false },
		};
		m.hook.mockReturnValue({
			messages: [{ id: "answer", role: "assistant", turn }],
			running: true,
			send: m.send,
			reset: m.reset,
			stop: m.stop,
		});
		const { rerender } = render(
			<DataAnalystChat organizationId="example-org" />,
		);
		await act(async () => {
			await vi.dynamicImportSettled();
		});
		expect(screen.getByText("Partial answer")).toBeInTheDocument();
		expect(screen.queryByText("Answered by example-served")).toBeNull();
		m.hook.mockReturnValue({
			messages: [
				{
					id: "answer",
					role: "assistant",
					turn: { ...turn, status: "stopped" },
				},
			],
			running: false,
			send: m.send,
			reset: m.reset,
			stop: m.stop,
		});
		rerender(<DataAnalystChat organizationId="example-org" />);
		expect(screen.getAllByText("Stopped")).toHaveLength(1);
		expect(screen.queryByText("Analyzing…")).toBeNull();
		await act(async () => {
			m.deferResult = false;
			m.resultReady.resolve();
		});
		expect(
			await screen.findByText("Answered by example-served"),
		).toBeInTheDocument();
		expect(screen.getAllByText("Stopped")).toHaveLength(1);
		expect(screen.getAllByText("Partial answer")).toHaveLength(1);
	});
	it("shows a partial-turn error before and after results finish loading", async () => {
		m.deferResult = true;
		m.hook.mockReturnValue({
			messages: [
				{
					id: "answer",
					role: "assistant",
					turn: {
						...EMPTY_DATA_ANALYST_TURN,
						text: "Partial answer",
						status: "failed",
						error: "The analysis failed. Please try again.",
					},
				},
			],
			running: false,
			send: m.send,
			reset: m.reset,
			stop: m.stop,
		});
		render(<DataAnalystChat organizationId="example-org" />);
		await act(async () => {
			await vi.dynamicImportSettled();
		});
		expect(screen.getByRole("alert")).toHaveTextContent(
			"The analysis failed. Please try again.",
		);
		expect(screen.getByText("Partial answer")).toBeInTheDocument();
		await act(async () => {
			m.deferResult = false;
			m.resultReady.resolve();
		});
		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"The analysis failed. Please try again.",
		);
		expect(screen.getAllByText("Partial answer")).toHaveLength(1);
		expect(screen.queryByText("Analyzing…")).toBeNull();
	});
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
		await act(async () => {
			await vi.dynamicImportSettled();
		});
		expect(await screen.findByText("Answer loaded")).toBeInTheDocument();
		expect(container.querySelector("img")).toBeNull();
	});
	it("offers the shared plan action for the chat's organization", async () => {
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
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Use organization billing",
			}),
		);
		expect(m.action).toHaveBeenCalledWith(planSpent, "org-example-1");
		expect(m.actionClick).toHaveBeenCalledTimes(1);
	});
});
