import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	const listeners = new Set<Record<string, (args: any) => void>>();
	const agent = {
		agentId: "prompt_enhancer",
		state: {} as Record<string, unknown>,
		subscribe: (subscriber: any) => {
			listeners.add(subscriber);
			return { unsubscribe: () => listeners.delete(subscriber) };
		},
		setState: (state: any) => {
			agent.state = structuredClone(state);
			for (const s of listeners) {
				s.onStateChanged?.({ state });
			}
		},
	};
	const runtimeListeners = new Set<Record<string, (args: any) => void>>();
	const runtime = {
		agents: { prompt_enhancer: agent },
		subscribe: (subscriber: any) => {
			runtimeListeners.add(subscriber);
			return { unsubscribe: () => runtimeListeners.delete(subscriber) };
		},
	};
	return { agent, listeners, runtime, runtimeListeners };
});
vi.mock("@copilotkit/react-core/v2", () => ({
	useAgent: vi.fn(() => ({ agent: fake.agent })),
	useCopilotKit: () => ({ copilotkit: fake.runtime }),
}));
vi.mock("@copilotkit/react-core/v2/context", () => ({
	useCopilotKit: () => ({ copilotkit: fake.runtime }),
}));

import { PromptContentEnhancer } from "@saas/prompts/components/PromptContentEnhancer";

const h = vi.hoisted(() => ({
	renders: 0,
	loading: false,
	action: null as any,
}));
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({
		state: fake.agent.state,
		setState: fake.agent.setState,
	}),
	useCopilotChat: () => ({ isLoading: false }),
	useCopilotReadable: () => {
		h.renders++;
	},
	useCopilotAction: (action: any) => {
		h.action = action;
	},
}));
vi.mock("@saas/shared/components/copilot/CopilotChatSessionProvider", () => ({
	useCopilotChatSessionSelector: (select: any) =>
		select({ isLoading: h.loading }),
}));
vi.mock("@saas/agents/copilot/useConfirmChangesVerdict", () => ({
	useConfirmChangesVerdict: () => () => vi.fn(),
	useConfirmChangesVerdictCard: () => ({}),
}));
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: any) => children,
}));
vi.mock("@saas/shared/components/copilot/CopilotAssistantMessage", () => ({
	CopilotAssistantMessageForPromptEnhancer: () => null,
}));
vi.mock("@saas/shared/components/FabricLogo", () => ({
	FabricLogo: () => null,
}));
const props = {
	promptId: "example-prompt",
	promptName: "Example",
	format: "PLAIN_TEXT" as const,
	tags: [],
	initialContent: "Original",
	onSave: vi.fn(),
	onCancel: vi.fn(),
};
beforeEach(() => {
	fake.listeners.clear();
	fake.runtimeListeners.clear();
	fake.agent.state = { streamingContent: "Original", extra: "preserved" };
	h.loading = false;
	h.renders = 0;
});
describe("prompt enhancer selected state", () => {
	it("restores edited content after a wipe with reseed subscribers notified in registration order", () => {
		render(<PromptContentEnhancer {...props} />);
		fireEvent.change(screen.getByPlaceholderText(/prompt here/), {
			target: { value: "Edited prompt" },
		});
		act(() => {
			fake.agent.setState({});
			// Set iteration preserves the runtime subscription registration order.
			for (const subscriber of fake.runtimeListeners) {
				subscriber.onAgentRunStarted?.({ agent: fake.agent });
			}
		});
		expect(fake.agent.state).toEqual(
			expect.objectContaining({
				currentContent: "Edited prompt",
				enhancedContent: "Edited prompt",
				streamingContent: "Edited prompt",
			}),
		);
	});
	it("ignores unread changes and displays streaming diffs using session loading", () => {
		h.loading = true;
		const view = render(<PromptContentEnhancer {...props} />);
		const before = h.renders;
		act(() => fake.agent.setState({ ...fake.agent.state, error: "new" }));
		expect.soft(h.renders).toBe(before);
		act(() =>
			fake.agent.setState({
				...fake.agent.state,
				streamingContent: "Original improved",
			}),
		);
		expect.soft(h.renders).toBeGreaterThan(before);
		expect
			.soft(view.container.querySelector("ins"))
			.toHaveTextContent("improved");
	});
	it("saves the AI's change while it still shows as a diff", () => {
		const onSave = vi.fn();
		h.loading = true;
		const view = render(
			<PromptContentEnhancer {...props} onSave={onSave} />,
		);
		act(() =>
			fake.agent.setState({
				...fake.agent.state,
				streamingContent: "Original improved",
			}),
		);
		h.loading = false;
		view.rerender(<PromptContentEnhancer {...props} onSave={onSave} />);
		act(() => {
			for (const subscriber of fake.listeners) {
				subscriber.onRunFinishedEvent?.({ outcome: "success" });
			}
		});

		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(onSave).toHaveBeenCalledWith("Original improved");
	});
	it("saves the editor's text when no AI change is on screen", () => {
		const onSave = vi.fn();
		render(<PromptContentEnhancer {...props} onSave={onSave} />);

		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(onSave).toHaveBeenCalledWith("Original");
	});
	for (const accept of [true, false]) {
		it(`preserves live fields on ${accept ? "accept" : "reject"} and editing writes`, () => {
			render(<PromptContentEnhancer {...props} />);
			act(() =>
				fake.agent.setState({
					...fake.agent.state,
					streamingContent: "Improved",
					extra: "live",
				}),
			);
			const card = h.action.renderAndWaitForResponse({
				args: {},
				respond: vi.fn(),
				status: "executing",
			});
			act(() => card.props[accept ? "onConfirm" : "onReject"]());
			expect.soft(fake.agent.state.extra).toBe("live");
			expect
				.soft(fake.agent.state.enhancedContent)
				.toBe(accept ? "Improved" : "Original");
			fireEvent.change(screen.getByPlaceholderText(/prompt here/), {
				target: { value: "Edited" },
			});
			expect.soft(fake.agent.state.extra).toBe("live");
			expect.soft(fake.agent.state.streamingContent).toBe("Edited");
		});
	}
});
