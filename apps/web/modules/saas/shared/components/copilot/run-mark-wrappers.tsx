"use client";

import type {
	AssistantMessageProps,
	RenderSuggestionsListProps,
} from "@copilotkit/react-ui";
import type { ComponentType } from "react";
import { useCopilotChatSession } from "./CopilotChatSessionProvider";

/**
 * Suggestion chips and the assistant bubble's "Regenerate" button both start
 * an agent run through CopilotKit internals — a suggestion click calls
 * `RenderSuggestionsList`'s `onSuggestionClick` directly, and Regenerate
 * calls `AssistantMessageProps.onRegenerate` — neither routes through the
 * custom `Input` component, so neither ever reaches `onUserSend`
 * (`CopilotSidebarInput.tsx`). These factories wrap the two entry points so
 * `markUserRunInitiated` (see `useUserRunSignal`'s doc-comment) still fires
 * for these user-initiated runs, keeping the "AI is generating" pill honest.
 */

/**
 * Renders the suggestion chips so a chip click marks the upcoming run as
 * user-initiated before forwarding the click to CopilotKit's own handler
 * (which sends the suggestion's message).
 *
 * The chips are rendered here rather than through `@copilotkit/react-ui`'s
 * `RenderSuggestionsList`, because on 1.70 that list mounts one `Suggestion`
 * button per chip and every one of them calls `useCopilotChatInternal()` for
 * `isLoading`, which opens its own `agent/connect` (Fizzy #2389 — three
 * static chips measured as three connects). This list reads `isLoading` once
 * from the surface's `<CopilotChatSessionProvider>` instead. The markup and
 * class names (`suggestions`, `suggestion`, `loading`) match react-ui's so
 * the existing stylesheet applies unchanged.
 */
export function makeSuggestionsListWithRunMark(
	markUserRunInitiated: () => void,
): ComponentType<RenderSuggestionsListProps> {
	return function SuggestionsListWithRunMark({
		suggestions,
		onSuggestionClick,
		isLoading: suggestionsLoading,
	}: RenderSuggestionsListProps) {
		const { isLoading: chatLoading } = useCopilotChatSession();
		return (
			<div className="suggestions">
				{suggestions.map((suggestion, index) => {
					if (!suggestion.title) {
						return null;
					}
					const partial =
						suggestion.isLoading ??
						suggestion.partial ??
						suggestionsLoading;
					return (
						<button
							key={index}
							type="button"
							disabled={partial || chatLoading}
							aria-busy={partial || undefined}
							className={`suggestion ${suggestion.className ?? ""} ${partial ? "loading" : ""}`}
							data-test-id="suggestion"
							onClick={(event) => {
								event.preventDefault();
								markUserRunInitiated();
								onSuggestionClick(suggestion.message);
							}}
						>
							<span>{suggestion.title}</span>
						</button>
					);
				})}
			</div>
		);
	};
}

/**
 * Wraps a host's `AssistantMessage` component so clicking "Regenerate" marks
 * the upcoming run as user-initiated before forwarding to the original
 * `onRegenerate`. Leaves `onRegenerate` `undefined` when the base component
 * wasn't given one, matching CopilotKit's own optional-callback contract.
 */
export function makeAssistantMessageWithRunMark(
	AssistantMessage: ComponentType<AssistantMessageProps>,
	markUserRunInitiated: () => void,
): ComponentType<AssistantMessageProps> {
	return function AssistantMessageWithRunMark(props: AssistantMessageProps) {
		return (
			<AssistantMessage
				{...props}
				onRegenerate={
					props.onRegenerate
						? () => {
								markUserRunInitiated();
								props.onRegenerate?.();
							}
						: undefined
				}
			/>
		);
	};
}
