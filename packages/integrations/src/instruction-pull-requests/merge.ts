/**
 * The shared half of an adapter's `merge`: one write request whose refusals
 * become a REFUSED result instead of an error. Each adapter names which
 * statuses mean "not mergeable" and "head moved"; everything else falls back
 * to the generic status classification. Only the status and the headers are
 * read, never a body, and the one header kept
 * (`X-Accepted-GitHub-Permissions`) names permissions, nothing secret.
 */
import { LOOKUP_TIMEOUT_MS } from "./classify";
import { type JsonResponse, requestJson } from "./http";
import {
	type Cause,
	InstructionPullRequestError,
	type MergeRefusalReason,
	type MergeResult,
	type Target,
} from "./types";

type Refused = Extract<MergeResult, { kind: "REFUSED" }>;

class MergeRefusal extends Error {
	constructor(readonly result: Refused) {
		super("Merge refused");
	}
}

const REASON_OF_CAUSE: Record<Cause, MergeRefusalReason> = {
	auth: "auth",
	permission: "permission",
	rate_limit: "rate_limit",
	not_found: "not_found",
	conflict: "not_mergeable",
	transient: "transient",
	unknown: "unknown",
};

export async function requestMerge(input: {
	target: Target;
	url: string;
	origin: string;
	headers: Record<string, string>;
	body: unknown;
	/** The adapter's own reading of a status; null leaves it to the generic one. */
	reasonOf: (status: number) => MergeRefusalReason | null;
}): Promise<{ kind: "MERGED"; response: JsonResponse } | Refused> {
	try {
		const response = await requestJson({
			target: input.target,
			operation: "merge",
			method: "PUT",
			url: input.url,
			origin: input.origin,
			headers: input.headers,
			body: input.body,
			timeoutMs: LOOKUP_TIMEOUT_MS,
			onRefusal: (status, headers) => {
				const reason = input.reasonOf(status);
				const accepted = headers
					.get("x-accepted-github-permissions")
					?.slice(0, 200);
				if (reason !== null) {
					throw new MergeRefusal({
						kind: "REFUSED",
						reason,
						...(accepted ? { acceptedPermissions: accepted } : {}),
					});
				}
				if (status === 403 && accepted) {
					// The generic classification still decides rate limit vs
					// permission; the header rides along on a permission refusal.
					const rateLimited =
						headers.get("x-ratelimit-remaining") === "0" ||
						headers.get("retry-after") !== null;
					if (!rateLimited) {
						throw new MergeRefusal({
							kind: "REFUSED",
							reason: "permission",
							acceptedPermissions: accepted,
						});
					}
				}
			},
		});
		return { kind: "MERGED", response };
	} catch (error) {
		if (error instanceof MergeRefusal) {
			return error.result;
		}
		if (error instanceof InstructionPullRequestError) {
			return {
				kind: "REFUSED",
				reason: REASON_OF_CAUSE[error.cause],
				...(error.retryAfterSeconds === undefined
					? {}
					: { retryAfterSeconds: error.retryAfterSeconds }),
			};
		}
		// Cancellation, as itself.
		throw error;
	}
}
