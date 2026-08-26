/**
 * Unit tests for the `run-mark-wrappers` factories — the interception point
 * for user-initiated runs that bypass `CopilotSidebarInput`'s `onUserSend`
 * (suggestion chips and the assistant bubble's "Regenerate" button both
 * start a run through CopilotKit internals). See the module doc-comment and
 * `useUserRunSignal`'s doc-comment for why these entry points need their
 * own mark.
 */

import type {
	AssistantMessageProps,
	RenderSuggestionsListProps,
} from "@copilotkit/react-ui";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";

// Minimal stub for CopilotKit's default suggestions renderer — real one
// needs live chat context we don't want to stand up here. Renders one
// button per suggestion, forwarding `message` to `onSuggestionClick`.
vi.mock("@copilotkit/react-ui", () => ({
	RenderSuggestionsList: ({
		suggestions,
		onSuggestionClick,
	}: RenderSuggestionsListProps) => (
		<div>
			{suggestions.map((s) => (
				<button
					key={s.title}
					type="button"
					onClick={() => onSuggestionClick(s.message)}
				>
					{s.title}
				</button>
			))}
		</div>
	),
}));

import {
	makeAssistantMessageWithRunMark,
	makeSuggestionsListWithRunMark,
} from "../run-mark-wrappers";

describe("makeSuggestionsListWithRunMark", () => {
	it("marks the run before forwarding the suggestion click", () => {
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
