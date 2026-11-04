/** Server admission descriptor. Only newly admitted native executions carry it. */
export interface NativeAgentAdmission {
	version: 1;
	executionRowId: string;
	requestHash: string;
}

export const NATIVE_AGENT_RECEIPT_PATCH = "saved-agent-native-receipt-v1";

/** Predispatch refusal is different from an unacknowledged external effect. */
export function hasUnconfirmedAgentEffect(
	calls: ReadonlyArray<{
		status: string;
		result?: unknown;
		inspectionRequired?: boolean;
	}>,
): boolean {
	return calls.some(
		(call) =>
			call.status === "pending" ||
			call.inspectionRequired === true ||
			(!!call.result &&
				typeof call.result === "object" &&
				"inspectionRequired" in call.result &&
				call.result.inspectionRequired === true),
	);
}
