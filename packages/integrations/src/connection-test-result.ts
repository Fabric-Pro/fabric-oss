/** Current authorization evidence from a provider connection check. */
export type ConnectionCheckStatus =
	| "connected"
	| "reconnect_required"
	| "unknown";

/** Additive status keeps providers that return only success/message/error compatible. */
export interface ConnectionTestResult {
	success: boolean;
	status?: ConnectionCheckStatus;
	message?: string;
	error?: string;
}
