/** Server-side starter opt-in; workers select semantics from workflow input. */
export function orchestratorApprovalProtocol(): { approvalProtocol?: 2 } {
	return process.env.ORCHESTRATOR_APPROVAL_UPDATES_ENABLED === "true"
		? { approvalProtocol: 2 }
		: {};
}
