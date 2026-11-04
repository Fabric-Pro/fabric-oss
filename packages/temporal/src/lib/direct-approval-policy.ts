/**
 * Legacy Direct approval requests contain client-supplied tool arguments, not
 * a persisted single-use checkpoint/action receipt. An acting grant proves
 * identity and tenant; it does not turn those arguments into approval evidence.
 * Keep Direct reads available while approved actions use the supported runtime.
 */
export const DIRECT_RUNTIME_AGENT_ID = "fabric-direct";

export const DIRECT_APPROVAL_UNSUPPORTED_MESSAGE =
	"Direct chat cannot resume actions that need approval. Switch to Advisor Simple (Orchestrator), describe the action and review its approval there. This approval request was not dispatched. If an earlier attempt has an unknown outcome, check its status before trying again.";

export const DIRECT_APPROVAL_CAPABILITIES = {
	approvalResume: false,
	approvalRuntime: "orchestrator",
} as const;

export function directApprovalRefusal(approvedToolCall: unknown) {
	return approvedToolCall === undefined || approvedToolCall === null
		? null
		: {
				code: "DIRECT_APPROVAL_UNSUPPORTED" as const,
				message: DIRECT_APPROVAL_UNSUPPORTED_MESSAGE,
				status: 409 as const,
			};
}

/** A tool result, not a new approval card or a claim that an earlier attempt failed. */
export function directApprovalUnavailableResult() {
	return {
		error: DIRECT_APPROVAL_UNSUPPORTED_MESSAGE,
		code: "DIRECT_APPROVAL_UNSUPPORTED" as const,
		requiresConfirmation: false,
	};
}
