/** Hash-only request diagnostics shared with the deterministic workflow sandbox. */
export interface RequestPartShape {
	hash: string;
	bytes: number;
	role?: "system" | "user" | "assistant" | "tool" | "other";
}
export interface RequestFingerprint {
	boundary: "provider" | "wire";
	modelHash: string;
	routeHash: string;
	tools: RequestPartShape[];
	system: RequestPartShape[];
	messages: RequestPartShape[];
	cacheMarkers: number[][];
	toolChoice: RequestPartShape;
	sessionKeyHash?: string;
	bytes: number;
}
export interface ModelRequestObservation {
	/** Ordered names paired with fingerprint.tools; absent in older results. */
	toolNames?: string[];
	/** Names bound by the activity skill registry for this request. */
	skillToolNames?: string[];
	iteration: number;
	activityAttempt: number;
	activityIdHash?: string;
	streamAttempt?: number;
	request: number;
	fingerprint: RequestFingerprint;
	estimatedInputTokens: number;
	contextWindow?: number;
	inputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	uncachedInputTokens?: number;
	outputTokens?: number;
}
export type RequestChange = {
	section:
		| "initial"
		| "boundary"
		| "model"
		| "route"
		| "tools"
		| "system"
		| "messages"
		| "cacheMarkers"
		| "toolChoice"
		| "sessionKey";
	index?: number;
} | null;
export function firstRequestChange(
	previous: RequestFingerprint | undefined,
	next: RequestFingerprint,
): RequestChange {
	if (!previous) {
		return { section: "initial" };
	}
	if (previous.boundary !== next.boundary) {
		return { section: "boundary" };
	}
	if (previous.modelHash !== next.modelHash) {
		return { section: "model" };
	}
	if (previous.routeHash !== next.routeHash) {
		return { section: "route" };
	}
	for (const section of ["tools", "system", "messages"] as const) {
		for (
			let index = 0;
			index < Math.max(previous[section].length, next[section].length);
			index++
		) {
			if (
				previous[section][index]?.hash !== next[section][index]?.hash ||
				previous[section][index]?.role !== next[section][index]?.role
			) {
				return { section, index };
			}
		}
	}
	if (
		JSON.stringify(previous.cacheMarkers) !==
		JSON.stringify(next.cacheMarkers)
	) {
		return { section: "cacheMarkers" };
	}
	if (previous.toolChoice.hash !== next.toolChoice.hash) {
		return { section: "toolChoice" };
	}
	if (previous.sessionKeyHash !== next.sessionKeyHash) {
		return { section: "sessionKey" };
	}
	return null;
}
