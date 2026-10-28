"use client";

import { useMemo, useRef, useState } from "react";
import type { WorkflowConfirmation } from "../lib/direct-stream-protocol";
import type { DirectStreamMessage } from "./useDirectStream";

type WorkflowConfirmationStatus =
	| "requested"
	| "submitting"
	| "started"
	| "unconfirmed"
	| "failed"
	| "declined";

type Decision = {
	status: WorkflowConfirmationStatus;
	message?: string;
	executionId?: string;
};

export type WorkflowConfirmationView = WorkflowConfirmation &
	Decision & {
		messageId: string;
	};

/**
 * A local confirmation is consumed once, before dispatch. Network failure after
 * dispatch is an unknown outcome, never permission to retry a write. The server
 * independently checks current tenant and workflow permissions on every start.
 */
export function useWorkflowConfirmation({
	messages,
	organizationId,
	isLoading,
}: {
	messages: DirectStreamMessage[];
	organizationId?: string;
	isLoading: boolean;
}) {
	const [decisions, setDecisions] = useState<Record<string, Decision>>({});
	const consumed = useRef(new Set<string>());
	const origins = useRef(new Map<string, string>());
	const message = messages.at(-1);
	if (message && organizationId && !origins.current.has(message.id)) {
		origins.current.set(message.id, organizationId);
	}
	const request =
		message?.role === "assistant" &&
		origins.current.get(message.id) === organizationId &&
		!message.isStreaming &&
		message.streamStatus !== "cancelled" &&
		message.streamStatus !== "error" &&
		message.pendingConfirmation &&
		"workflowId" in message.pendingConfirmation
			? message.pendingConfirmation
			: undefined;
	// Message IDs are unique across turns/conversations; organization is explicit.
	const key = request
		? JSON.stringify([organizationId, message?.id, request.workflowId])
		: null;
	const decision = key ? decisions[key] : undefined;
	const confirmation = useMemo<WorkflowConfirmationView | null>(
		() =>
			request && message
				? {
						...request,
						messageId: message.id,
						status: "requested",
						...decision,
					}
				: null,
		[request, message?.id, decision],
	);

	const inFlight = Object.values(decisions).some(
		(item) => item.status === "submitting",
	);

	function record(key: string, value: Decision) {
		setDecisions((previous) => ({ ...previous, [key]: value }));
	}

	async function confirm() {
		if (
			!key ||
			!request ||
			!organizationId ||
			isLoading ||
			inFlight ||
			consumed.current.has(key)
		) {
			return;
		}
		consumed.current.add(key);
		record(key, { status: "submitting" });
		try {
			const response = await fetch(
				"/api/agents/fabric-ai/execute-workflow",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workflowId: request.workflowId,
						organizationId,
					}),
				},
			);
			const data: unknown = await response.json();
			const payload =
				typeof data === "object" && data !== null ? data : {};
			const executionId =
				"executionId" in payload &&
				typeof payload.executionId === "string"
					? payload.executionId
					: undefined;
			if (!response.ok && response.status < 500) {
				record(key, {
					status: "failed",
					message:
						"error" in payload && typeof payload.error === "string"
							? payload.error
							: "The workflow start was rejected.",
				});
			} else if (
				response.ok &&
				response.status !== 202 &&
				"success" in payload &&
				payload.success === true &&
				executionId &&
				!("status" in payload && payload.status === "unconfirmed")
			) {
				record(key, { status: "started", executionId });
			} else {
				record(key, { status: "unconfirmed", executionId });
			}
		} catch {
			// The request may have reached the server even when its reply is lost.
			record(key, { status: "unconfirmed" });
		}
	}

	function decline() {
		if (!key || isLoading || inFlight || consumed.current.has(key)) {
			return;
		}
		consumed.current.add(key);
		record(key, { status: "declined" });
	}

	return {
		confirmation,
		confirm,
		decline,
		disabled: isLoading || inFlight || !organizationId,
	};
}
