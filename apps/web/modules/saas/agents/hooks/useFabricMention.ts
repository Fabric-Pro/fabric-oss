"use client";

/**
 * useFabricMention - Hook for detecting @fabric mentions in text inputs
 *
 * This hook provides a handler that detects when users type "@fabric" followed by
 * a query, and opens the Fabric Agent launcher with the appropriate context.
 *
 * Usage:
 * ```tsx
 * const { handleInputChange, isPending } = useFabricMention({
 *   projectId,
 *   projectName,
 *   storyId,
 *   storyIdentifier,
 *   storyTitle,
 *   taskId,
 *   taskIdentifier,
 *   taskTitle,
 * });
 *
 * <Textarea
 *   value={value}
 *   onChange={(e) => {
 *     const result = handleInputChange(e.target.value);
 *     if (!result.consumed) {
 *       setValue(result.value);
 *     }
 *   }}
 * />
 * ```
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	type FabricAgentLaunchContext,
	useFabricAgentLauncher,
} from "../components/FabricAgentLauncher";

interface UseFabricMentionOptions extends FabricAgentLaunchContext {
	/** Called when mention is detected and launcher is opening */
	onMentionTrigger?: (query: string) => void;
}

interface HandleInputChangeResult {
	/** Whether the @fabric mention was consumed (launcher opened) */
	consumed: boolean;
	/** The value to set in the input (cleared if consumed) */
	value: string;
	/** The detected query from the mention */
	query?: string;
}

/**
 * Detects @fabric mention patterns in text.
 * Matches standalone @fabric mentions, but avoids emails such as @fabric.example.
 */
const FABRIC_MENTION_REGEX = /(^|\s)@fabric(?=$|\s|[:,.!?])[:,]?\s*(.*)$/i;

export function useFabricMention(options: UseFabricMentionOptions) {
	const { openLauncher } = useFabricAgentLauncher();
	const [isPending, setIsPending] = useState(false);
	const lastProcessedValueRef = useRef<string>("");
	const pendingResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (pendingResetRef.current !== null) {
				clearTimeout(pendingResetRef.current);
				pendingResetRef.current = null;
			}
		},
		[],
	);

	const handleInputChange = useCallback(
		(value: string): HandleInputChangeResult => {
			// Prevent processing the same value twice (e.g., from React re-renders)
			if (value === lastProcessedValueRef.current) {
				return { consumed: false, value };
			}
			lastProcessedValueRef.current = value;

			const match = value.match(FABRIC_MENTION_REGEX);
			if (!match) {
				return { consumed: false, value };
			}

			const query = match[2]?.trim() || "";

			// Build context from options
			const context: FabricAgentLaunchContext = {
				projectId: options.projectId,
				projectName: options.projectName,
				storyId: options.storyId,
				storyIdentifier: options.storyIdentifier,
				storyTitle: options.storyTitle,
				taskId: options.taskId,
				taskIdentifier: options.taskIdentifier,
				taskTitle: options.taskTitle,
				prompt: query || undefined,
			};

			setIsPending(true);
			openLauncher(context);
			options.onMentionTrigger?.(query);

			// Small delay to prevent immediate re-processing. Track the
			// timeout so the unmount cleanup can cancel it — otherwise the
			// callback fires after the component is gone and React's
			// dispatchSetState crashes (e.g. in tests where the jsdom
			// `window` is torn down before the 100ms elapses).
			if (pendingResetRef.current !== null) {
				clearTimeout(pendingResetRef.current);
			}
			pendingResetRef.current = setTimeout(() => {
				pendingResetRef.current = null;
				setIsPending(false);
			}, 100);

			return {
				consumed: true,
				value: "", // Clear the input after triggering
				query,
			};
		},
		[
			openLauncher,
			options.projectId,
			options.projectName,
			options.storyId,
			options.storyIdentifier,
			options.storyTitle,
			options.taskId,
			options.taskIdentifier,
			options.taskTitle,
			options.onMentionTrigger,
		],
	);

	/**
	 * Manually trigger the launcher with the current context
	 * Useful for "Ask Fabric Agent" buttons
	 */
	const triggerLauncher = useCallback(
		(prompt?: string) => {
			const context: FabricAgentLaunchContext = {
				projectId: options.projectId,
				projectName: options.projectName,
				storyId: options.storyId,
				storyIdentifier: options.storyIdentifier,
				storyTitle: options.storyTitle,
				taskId: options.taskId,
				taskIdentifier: options.taskIdentifier,
				taskTitle: options.taskTitle,
				prompt,
			};
			openLauncher(context);
		},
		[
			openLauncher,
			options.projectId,
			options.projectName,
			options.storyId,
			options.storyIdentifier,
			options.storyTitle,
			options.taskId,
			options.taskIdentifier,
			options.taskTitle,
		],
	);

	return {
		handleInputChange,
		triggerLauncher,
		isPending,
	};
}
