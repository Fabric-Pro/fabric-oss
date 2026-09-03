/**
 * Unit tests for the `run-mark-wrappers` factories — the interception point
 * for user-initiated runs that bypass `CopilotSidebarInput`'s `onUserSend`
 * (suggestion chips and the assistant bubble's "Regenerate" button both
 * start a run through CopilotKit internals). See the module doc-comment and
 * `useUserRunSignal`'s doc-comment for why these entry points need their
 * own mark.
 *
 * The suggestions list is rendered by the wrapper itself rather than by
 * react-ui's `RenderSuggestionsList`, because on 1.70 that list calls the
 * connecting `useCopilotChatInternal()` once per chip (Fizzy #2389). The
 * mock boundary therefore stays at `@copilotkit/react-core`, with the real
 * `CopilotChatSessionProvider` mounted above the wrapper, so the "one hook
 * call for N chips" property is asserted against the real provider.
 */

import type { AssistantMessageProps } from "@copilotkit/react-ui";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ComponentType, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useCopilotChatInternalMock = vi.fn();

vi.mock("@copilotkit/react-core", () => ({
	useCopilotChatInternal: () => useCopilotChatInternalMock(),
}));

import { CopilotChatSessionProvider } from "../CopilotChatSessionProvider";
import {
	makeAssistantMessageWithRunMark,
	makeSuggestionsListWithRunMark,
} from "../run-mark-wrappers";

// react-ui's chips carry `data-test-id` (not testing-library's default
// `data-testid`), and the wrapper keeps that attribute so anything keyed on
// it keeps working — so query it directly.
function chips(container: HTMLElement): HTMLButtonElement[] {
	return Array.from(
		container.querySelectorAll<HTMLButtonElement>(
			'[data-test-id="suggestion"]',
		),
	);
}

function render(ui: ReactElement) {
	return rtlRender(ui, {
		wrapper: ({ children }) => (
			<CopilotChatSessionProvider>{children}</CopilotChatSessionProvider>
		),
	});
}

afterEach(() => {
	useCopilotChatInternalMock.mockReset();
});

describe("makeSuggestionsListWithRunMark", () => {
	it("marks the run before forwarding the suggestion click", () => {
		useCopilotChatInternalMock.mockReturnValue({ isLoading: false });
		const markUserRunInitiated = vi.fn();
		const onSuggestionClick = vi.fn();
		const Wrapped = makeSuggestionsListWithRunMark(markUserRunInitiated);

		render(
			<Wrapped
				suggestions={[
					{ title: "Improve description", message: "do it" },
				]}
				onSuggestionClick={onSuggestionClick}
				isLoading={false}
			/>,
		);

		fireEvent.click(screen.getByText("Improve description"));

		expect(markUserRunInitiated).toHaveBeenCalledTimes(1);
		expect(onSuggestionClick).toHaveBeenCalledTimes(1);
		expect(onSuggestionClick).toHaveBeenCalledWith("do it");
		const markOrder = markUserRunInitiated.mock.invocationCallOrder[0] ?? 0;
		const clickOrder = onSuggestionClick.mock.invocationCallOrder[0] ?? 0;
		expect(markOrder).toBeLessThan(clickOrder);
	});

	it("reads chat state once for the whole list, not once per chip", () => {
		useCopilotChatInternalMock.mockReturnValue({ isLoading: false });
		const Wrapped = makeSuggestionsListWithRunMark(vi.fn());

		const { container } = render(
			<Wrapped
				suggestions={[
					{ title: "One", message: "1" },
					{ title: "Two", message: "2" },
					{ title: "Three", message: "3" },
				]}
				onSuggestionClick={vi.fn()}
				isLoading={false}
			/>,
		);

		expect(chips(container)).toHaveLength(3);
		// One call from the provider; the chips add none. The count is per
		// render, so it must not scale with the number of chips.
		expect(useCopilotChatInternalMock).toHaveBeenCalledTimes(1);
	});

	it("disables the chips while the chat is generating and keeps react-ui's class names", () => {
		useCopilotChatInternalMock.mockReturnValue({ isLoading: true });
		const onSuggestionClick = vi.fn();
		const Wrapped = makeSuggestionsListWithRunMark(vi.fn());

		const { container } = render(
			<Wrapped
				suggestions={[
					{ title: "Improve description", message: "do it" },
				]}
				onSuggestionClick={onSuggestionClick}
				isLoading={false}
			/>,
		);

		const [chip] = chips(container);
		expect(chip).toBeDisabled();
		expect(chip).toHaveClass("suggestion");
		expect(container.querySelector(".suggestions")).not.toBeNull();
		fireEvent.click(chip);
		expect(onSuggestionClick).not.toHaveBeenCalled();
	});

	it("marks a chip as loading when the suggestion itself is partial", () => {
		useCopilotChatInternalMock.mockReturnValue({ isLoading: false });
		const Wrapped = makeSuggestionsListWithRunMark(vi.fn());

		const { container } = render(
			<Wrapped
				suggestions={[
					{ title: "Pending", message: "p", partial: true },
					{ title: "Ready", message: "r" },
				]}
				onSuggestionClick={vi.fn()}
				isLoading={false}
			/>,
		);

		const [pending, ready] = chips(container);
		expect(pending).toBeDisabled();
		expect(pending).toHaveClass("loading");
		expect(ready).toBeEnabled();
		expect(ready).not.toHaveClass("loading");
	});
});

// Minimal stub standing in for a host's `AssistantMessage` component —
// renders a "Regenerate" button wired to whatever `onRegenerate` it was
// given (or nothing, if undefined), mirroring `CopilotAssistantMessage`'s
// actual `onClick={() => onRegenerate?.()}` wiring.
function StubAssistantMessage(props: AssistantMessageProps) {
	return (
		<button type="button" onClick={() => props.onRegenerate?.()}>
			Regenerate
		</button>
	);
}

const baseAssistantMessageProps: AssistantMessageProps = {
	isLoading: false,
	isGenerating: false,
	rawData: undefined,
};

describe("makeAssistantMessageWithRunMark", () => {
	it("marks the run before forwarding to the original onRegenerate", () => {
		useCopilotChatInternalMock.mockReturnValue({ isLoading: false });
		const markUserRunInitiated = vi.fn();
		const onRegenerate = vi.fn();
		const Wrapped = makeAssistantMessageWithRunMark(
			StubAssistantMessage as ComponentType<AssistantMessageProps>,
			markUserRunInitiated,
		);

		render(
			<Wrapped
				{...baseAssistantMessageProps}
				onRegenerate={onRegenerate}
			/>,
		);

		fireEvent.click(screen.getByText("Regenerate"));

		expect(markUserRunInitiated).toHaveBeenCalledTimes(1);
		expect(onRegenerate).toHaveBeenCalledTimes(1);
		const markOrder = markUserRunInitiated.mock.invocationCallOrder[0] ?? 0;
		const regenOrder = onRegenerate.mock.invocationCallOrder[0] ?? 0;
		expect(markOrder).toBeLessThan(regenOrder);
	});

	it("passes onRegenerate as undefined (no crash) when the base component wasn't given one", () => {
		useCopilotChatInternalMock.mockReturnValue({ isLoading: false });
		const markUserRunInitiated = vi.fn();
		const Wrapped = makeAssistantMessageWithRunMark(
			StubAssistantMessage as ComponentType<AssistantMessageProps>,
			markUserRunInitiated,
		);

		render(<Wrapped {...baseAssistantMessageProps} />);

		expect(() =>
			fireEvent.click(screen.getByText("Regenerate")),
		).not.toThrow();
		expect(markUserRunInitiated).not.toHaveBeenCalled();
	});
});
