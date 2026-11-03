/**
 * Scheduled code index refresh (spec 2026-10-29 code-index-sync): the poll's
 * activities. Claiming is a database write here; the check itself runs in the
 * web app, which owns the indexed-commit → HEAD diff and the indexing trigger
 * (`packages/api/modules/projects/lib/code-index-refresh.ts`).
 */

import { claimDueCodeIndexRefreshes } from "@repo/database";
import { ApplicationFailure } from "@temporalio/activity";
import { getFabricInternalBaseUrl } from "./shared/fabric-internal-url";

/** Thrown for a refusal the web app answered with a 4xx: never retried. */
export const CODE_INDEX_REFRESH_REJECTED = "CodeIndexRefreshRejected";

const REFRESH_REQUEST_TIMEOUT_MS = 90_000;

/** Claim the repository indexes due for a check (moves their next check). */
export async function claimDueCodeIndexRefreshesActivity(input: {
	limit: number;
}): Promise<string[]> {
	const claimed = await claimDueCodeIndexRefreshes({
		now: new Date(),
		limit: input.limit,
	});
	return claimed.map((row) => row.id);
}

/**
 * Ask the web app to check one repository index. A decision (up to date,
 * started, needs a full re-index, no credentials) comes back as a 200 with
 * its outcome; a 4xx is final; anything else is retried by the workflow.
 */
export async function requestCodeIndexRefreshActivity(input: {
	codeIndexId: string;
}): Promise<{ outcome: string }> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw ApplicationFailure.nonRetryable(
			"AGENT_SERVICE_SECRET is not configured on the worker.",
			CODE_INDEX_REFRESH_REJECTED,
		);
	}
	const response = await fetch(
		`${getFabricInternalBaseUrl()}/api/internal/code-index/refresh`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Agent-Service-Token": secret,
			},
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS),
		},
	);
	if (response.status >= 400 && response.status < 500) {
		throw ApplicationFailure.nonRetryable(
			`Code index refresh refused (${response.status})`,
			CODE_INDEX_REFRESH_REJECTED,
		);
	}
	if (!response.ok) {
		throw new Error(`Code index refresh failed (${response.status})`);
	}
	return (await response.json()) as { outcome: string };
}
