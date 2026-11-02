"use client";

import { useRuntimeChatTransport } from "@saas/agents/hooks/useRuntimeChatTransport";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type RefinementMessage,
	refineOverRoute,
	refineOverRuntime,
} from "../lib/weave-refine-client";

export interface WeaveRefinement {
	/**
	 * The completed exchanges, plus the input in flight. A reply is added
	 * only once it is complete, on either transport.
	 */
	messages: RefinementMessage[];
	/** The runtime reply as it streams in; always "" on the route. */
	pendingReply: string;
	isThinking: boolean;
	isReady: boolean;
	send: (args: {
		refinementInput: string;
		currentMessage: string;
	}) => Promise<void>;
}

/**
 * Create Plan's "Refine request with AI": each input goes, with the
 * exchanges so far, to `weave.plans.refine` or, while
 * `COPILOTKIT_WEAVE_REFINE_CHAT` is on for the organization on screen when
 * the form mounts, to the agent runtime, which streams the feedback. On
 * either, the improved request (`onUpdatedMessage`), the ready state and
 * the reply land together when the reply is complete; a failure shows a
 * toast and takes the input back out. Unmounting lets go of the request
 * silently.
 */
export function useWeaveRefinement({
	projectId,
	onUpdatedMessage,
}: {
	projectId: string;
	onUpdatedMessage: (message: string) => void;
}): WeaveRefinement {
	const transport = useRuntimeChatTransport("COPILOTKIT_WEAVE_REFINE_CHAT");
	const { organizationId } = useOrganizationContext();
	const [messages, setMessages] = useState<RefinementMessage[]>([]);
	const [pendingReply, setPendingReply] = useState("");
	const [isThinking, setIsThinking] = useState(false);
	const [isReady, setIsReady] = useState(false);
	const requestRef = useRef<AbortController | null>(null);

	useEffect(
		() => () => {
			requestRef.current?.abort();
			requestRef.current = null;
		},
		[],
	);

	const send = useCallback(
		async ({
			refinementInput,
			currentMessage,
		}: {
			refinementInput: string;
			currentMessage: string;
		}) => {
			const history = messages;
			setMessages((prev) => [
				...prev,
				{ role: "user", content: refinementInput },
			]);
			setIsThinking(true);
			const controller = new AbortController();
			requestRef.current = controller;
			const request = {
				projectId,
				currentMessage,
				refinementInput,
				history,
			};

			try {
				const reply =
					transport === "runtime"
						? await refineOverRuntime({
								...request,
								organizationId: organizationId ?? undefined,
								signal: controller.signal,
								onText: setPendingReply,
							})
						: await refineOverRoute({
								...request,
								organizationId: organizationId ?? null,
							});
				if (controller.signal.aborted) {
					return;
				}
				// Update the main message with the AI-improved version
				onUpdatedMessage(reply.updatedMessage);
				setIsReady(reply.isReady);
				setMessages((prev) => [
					...prev,
					{ role: "assistant", content: reply.feedback },
				]);
			} catch (error) {
				if (transport === "runtime" && controller.signal.aborted) {
					return;
				}
				toast.error(
					`Refinement failed: ${error instanceof Error ? error.message : "Unknown error"}`,
				);
				// Remove the user message on failure
				setMessages((prev) => prev.slice(0, -1));
			} finally {
				if (requestRef.current === controller) {
					requestRef.current = null;
				}
				setPendingReply("");
				setIsThinking(false);
			}
		},
		[messages, projectId, organizationId, transport, onUpdatedMessage],
	);

	return { messages, pendingReply, isThinking, isReady, send };
}
