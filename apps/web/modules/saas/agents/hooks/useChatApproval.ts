"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ApprovalState = {
	key: string;
	status: "submitting" | "accepted" | "unconfirmed" | "rejected";
	approved: boolean;
	error?: string;
};

/** Shared decision lifecycle for Research and Orchestrator approval cards. */
export function useChatApproval(
	executionId?: string | null,
	approvalId?: string | null,
) {
	const key = JSON.stringify([executionId, approvalId]);
	const currentKey = useRef<string | null>(key);
	currentKey.current = key;
	useEffect(() => {
		currentKey.current = key;
		return () => {
			if (currentKey.current === key) {
				currentKey.current = null;
			}
		};
	}, [key]);
	const attempts = useRef(new Set<string>());
	const [state, setState] = useState<ApprovalState | null>(null);
	const respond = useCallback(
		async (approved: boolean, feedback?: string) => {
			if (
				!executionId ||
				!approvalId ||
				currentKey.current !== key ||
				attempts.current.has(key)
			) {
				return false;
			}
			attempts.current.add(key);
			setState({ key, status: "submitting", approved });
			try {
				const response = await fetch(
					"/api/agents/fabric-ai/orchestrator-temporal/approve",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							executionId,
							approvalId,
							approved,
							feedback,
						}),
					},
				);
				const body = await response.json().catch(() => null);
				if (currentKey.current !== key) {
					return false;
				}
				if (
					!response.ok ||
					body?.success !== true ||
					body?.approved !== approved
				) {
					const ambiguous = response.status >= 500 || response.ok;
					setState({
						key,
						status: ambiguous ? "unconfirmed" : "rejected",
						approved,
						error: ambiguous
							? "The decision could not be confirmed. Reconnect to check the run."
							: "This approval could not be accepted. Refresh the conversation to check its status.",
					});
					return false;
				}
				setState({ key, status: "accepted", approved });
				return true;
			} catch {
				if (currentKey.current === key) {
					setState({
						key,
						status: "unconfirmed",
						approved,
						error: "The connection was lost. Reconnect to check whether the decision was accepted.",
					});
				}
				return false;
			}
		},
		[executionId, approvalId, key],
	);
	const current = state?.key === key ? state : null;
	return {
		respond,
		isSubmitting: current?.status === "submitting",
		disabled: !approvalId || !!current,
		decision: current?.status === "accepted" ? current.approved : null,
		submittingAction:
			current?.status === "submitting"
				? current.approved
					? "approve"
					: "reject"
				: null,
		error: current?.error,
	};
}
