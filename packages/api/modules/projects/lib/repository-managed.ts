/**
 * The refusal every surface gives for a knowledge file a Living Memory
 * repository sync authored (design 2026-09-23 §6): the repository is its
 * author of record, so it is changed or removed there and brought in with
 * "Sync now", never overwritten or deleted from the CLI, MCP or the tab.
 *
 * One shape for all of them: `ORPCError("CONFLICT")` whose `data.code` is
 * `REPOSITORY_MANAGED`, carrying the repository (`owner/name`) and branch —
 * both null when the configuration was removed between the reads, in which
 * case the message names "the connected repository". The v1 REST routes map
 * it to a 409 with a body of its own (`repositoryManagedBody`), distinct from
 * the hash-conflict 409, so a client can tell "someone changed it" from
 * "the repository owns it".
 */
import { ORPCError } from "@orpc/client";

export const REPOSITORY_MANAGED_CODE = "REPOSITORY_MANAGED" as const;

/** Which repository and branch own a row, as the database reads it. */
export interface RepositoryManagedLabel {
	repository: string | null;
	ref: string | null;
}

export interface RepositoryManagedErrorData extends RepositoryManagedLabel {
	code: typeof REPOSITORY_MANAGED_CODE;
}

/** "<path> is synced from <owner/name> @ <ref>; change it in the repository…" */
function repositoryManagedMessage(
	sourcePath: string,
	label: RepositoryManagedLabel,
): string {
	const origin = label.repository
		? label.ref
			? `${label.repository} @ ${label.ref}`
			: label.repository
		: "the connected repository";
	return `${sourcePath} is synced from ${origin}; change it in the repository and run Sync now.`;
}

export function repositoryManagedError(
	sourcePath: string,
	label: RepositoryManagedLabel,
): ORPCError<"CONFLICT", RepositoryManagedErrorData> {
	return new ORPCError("CONFLICT", {
		message: repositoryManagedMessage(sourcePath, label),
		data: {
			code: REPOSITORY_MANAGED_CODE,
			repository: label.repository,
			ref: label.ref,
		},
	});
}

/**
 * The v1 REST body for a `repositoryManagedError`, or `null` for any other
 * error: `{ error: { message, code: "REPOSITORY_MANAGED", repository, ref } }`,
 * answered with 409.
 */
export function repositoryManagedBody(error: unknown): {
	error: {
		message: string;
		code: typeof REPOSITORY_MANAGED_CODE;
		repository: string | null;
		ref: string | null;
	};
} | null {
	if (typeof error !== "object" || error === null) {
		return null;
	}
	const { code, data, message } = error as {
		code?: unknown;
		data?: unknown;
		message?: unknown;
	};
	if (code !== "CONFLICT" || typeof data !== "object" || data === null) {
		return null;
	}
	const fields = data as Partial<RepositoryManagedErrorData>;
	if (fields.code !== REPOSITORY_MANAGED_CODE) {
		return null;
	}
	return {
		error: {
			message: typeof message === "string" ? message : "",
			code: REPOSITORY_MANAGED_CODE,
			repository: fields.repository ?? null,
			ref: fields.ref ?? null,
		},
	};
}
