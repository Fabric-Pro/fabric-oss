"use client";

import {
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "@saas/payments/lib/ai-usage-limit-toast";
import { useCallback } from "react";
import { showPersistentAiErrorToast } from "./copilot-error-toast";

/** User-facing messages for known error types */
const ERROR_MESSAGES: Record<string, { title: string; description: string }> = {
	error: {
		title: "Request failed",
		description:
			"The AI agent could not process your request. Please try again.",
	},
	network: {
		title: "Connection failed",
		description:
			"Could not reach the AI service. Please check your connection and try again.",
	},
	agent_state: {
		title: "Agent error",
		description:
			"The AI agent encountered an error while processing. Please try again.",
	},
	action: {
		title: "Action failed",
		description:
			"An AI-triggered action failed to execute. Please try again.",
	},
};

/**
 * Detect an `AI_USAGE_LIMIT_EXCEEDED` error embedded anywhere in the
 * CopilotKit error event. CopilotKit nests the upstream error in
 * `event.error` (or sometimes `event.context.error`); the structured
 * payload ours sets travels at `error.data` (oRPC envelope) or directly
 * on `error` (raw class instance). We probe both shapes so the
 * contract holds regardless of which branch CopilotKit normalised
 * through. Returns the matched payload or `null`.
 */
function findAiUsageLimitPayload(
	// biome-ignore lint/suspicious/noExplicitAny: CopilotErrorEvent shape varies across @copilotkit/shared versions
	event: any,
):
	| import("@saas/payments/lib/ai-usage-limit-toast").AiUsageLimitExceededPayload
	| null {
	const candidates: unknown[] = [
		event?.error?.data,
		event?.error,
		event?.context?.error?.data,
		event?.context?.error,
		event,
	];
	for (const candidate of candidates) {
		const code = (candidate as { code?: unknown } | undefined)?.code;
		const data = (candidate as { data?: unknown } | undefined)?.data;
		if (code === "AI_USAGE_LIMIT_EXCEEDED") {
			if (isAiUsageLimitExceededPayload(data)) {
				return data;
			}
			if (isAiUsageLimitExceededPayload(candidate)) {
				return candidate;
			}
		}
		if (isAiUsageLimitExceededPayload(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * Hook that returns a CopilotKit `onError` handler.
 * The handler is typed loosely to avoid version-mismatch issues between
 * multiple `@copilotkit/shared` versions in the dependency tree.
 */
export function useCopilotErrorHandler() {
	const showAiUsageLimitToast = useShowAiUsageLimitToast();
	return useCallback(
		// biome-ignore lint/suspicious/noExplicitAny: CopilotErrorEvent shape varies across @copilotkit/shared versions
		(event: any) => {
			// AI usage-limit short-circuit.
			// When the upstream CopilotKit call surfaces our
			// structured `AI_USAGE_LIMIT_EXCEEDED` payload, render the
			// shared destructive toast and return so the generic
			// fallback below doesn't double-fire.
			const aiUsageLimitPayload = findAiUsageLimitPayload(event);
			if (aiUsageLimitPayload) {
				showAiUsageLimitToast(aiUsageLimitPayload);
				return;
			}

			const eventType: string = event?.type ?? "unknown";
			const source: string = event?.context?.source ?? "unknown";

			console.error(
				`[CopilotKit Error] type=${eventType} source=${source}`,
				event?.error,
				event?.context,
			);

			// Known error types → specific messages. Persist until the user
			// dismisses them (shared helper) so an assistant error delivered via
			// CopilotKit's onError can't vanish before it's seen.
			if (eventType in ERROR_MESSAGES) {
				const { title, description } = ERROR_MESSAGES[eventType];
				showPersistentAiErrorToast(title, description);
				return;
			}

			// Fallback for unknown errors
			showPersistentAiErrorToast(
				"Something went wrong",
				"An unexpected error occurred with the AI assistant. Please try again.",
			);
		},
		[showAiUsageLimitToast],
	);
}
