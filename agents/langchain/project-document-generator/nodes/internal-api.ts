/**
 * Shared pieces of every tool that calls the web app's internal API: where
 * that API lives, and what the model is told when the run's AI token stops
 * being accepted. Kept apart from the tool node so tool modules it imports
 * can use them without importing the tool node back.
 */

import { logger } from "@repo/logs";

/** Resolve the internal API base URL */
export function getApiUrl(): string {
	return (
		process.env.RUNTIME_API_URL ||
		process.env.FABRIC_API_URL ||
		process.env.NEXT_PUBLIC_SITE_URL ||
		"http://localhost:3001"
	);
}

/**
 * A 401 from an internal API almost always means the run's AI token expired
 * mid-generation (a long model call outliving the token TTL), not a
 * transient failure — so it's logged at error and the model is told to stop
 * retrying instead of silently continuing without the tool's context.
 */
export function internalApiFailure(tool: string, status: number): string {
	logger.error(
		`[ToolNode] ${tool} auth failed (401) — AI token likely expired mid-run`,
		{ status },
	);
	return `Authentication to ${tool} expired mid-run. Do not retry this tool; finish with the context already gathered.`;
}
