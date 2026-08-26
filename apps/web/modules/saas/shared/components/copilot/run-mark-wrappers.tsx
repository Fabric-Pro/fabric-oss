"use client";

import {
	type AssistantMessageProps,
	RenderSuggestionsList as DefaultSuggestionsList,
	type RenderSuggestionsListProps,
} from "@copilotkit/react-ui";
import type { ComponentType } from "react";

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
 * Wraps CopilotKit's default suggestions renderer so a chip click marks the
 * upcoming run as user-initiated before forwarding the click to CopilotKit's
 * own handler (which sends the suggestion's message).
 */
export function makeSuggestionsListWithRunMark(
	markUserRunInitiated: () => void,
): ComponentType<RenderSuggestionsListProps> {
	return function SuggestionsListWithRunMark(
		props: RenderSuggestionsListProps,
	) {
		return (
			<DefaultSuggestionsList
				{...props}
				onSuggestionClick={(message) => {
					markUserRunInitiated();
					props.onSuggestionClick(message);
				}}
			/>
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
