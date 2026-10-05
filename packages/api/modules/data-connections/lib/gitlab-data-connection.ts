/**
 * GitLab Data Connections hold no credential.
 *
 * A GitLab sync acts with the GitLab connection of the person who starts it,
 * read live from the GitLab connection service inside each sync activity. So
 * no writer stores a GitLab token on a `DataConnection` — not in the token
 * columns, not in the `credentials` JSON, and not through an assigned
 * `DataConnectionCredential`.
 */

import { ORPCError } from "@orpc/client";

export const GITLAB_DATA_CONNECTION_CREDENTIAL_REFUSED =
	"GitLab connections don't store credentials: a GitLab sync uses the GitLab account of the person who starts it. Connect GitLab under Integrations instead.";

/**
 * The column values that clear any legacy GitLab token copy, for a writer
 * that touches an existing GitLab Data Connection.
 */
export const GITLAB_DATA_CONNECTION_CLEARED_TOKENS = {
	accessToken: null,
	refreshToken: null,
	tokenExpiresAt: null,
	credentialId: null,
} as const;

/**
 * Refuse client-supplied credential material for a GitLab Data Connection: a
 * non-empty `credentials` object or a `credentialId` to assign. A null
 * `credentialId` (unassigning) is allowed.
 */
export function assertNoGitLabCredentialInput(input: {
	provider: string;
	credentials?: Record<string, unknown> | null;
	credentialId?: string | null;
}): void {
	if (input.provider !== "GITLAB") {
		return;
	}
	const hasCredentials =
		input.credentials != null && Object.keys(input.credentials).length > 0;
	if (hasCredentials || input.credentialId) {
		throw new ORPCError("BAD_REQUEST", {
			message: GITLAB_DATA_CONNECTION_CREDENTIAL_REFUSED,
		});
	}
}
