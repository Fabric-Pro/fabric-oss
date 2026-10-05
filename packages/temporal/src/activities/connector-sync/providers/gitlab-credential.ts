/**
 * The credential a GitLab Data Connection sync acts with.
 *
 * A GitLab Data Connection holds no token. Each GitLab connector-sync
 * activity resolves, inside the activity, the GitLab connection of the
 * person who started the sync — the `(userId, organizationId)` connection the
 * connection service owns, with the exclusive tenant filter — and the token
 * never leaves the activity: it is not in the activity's input or result, so
 * it never reaches workflow history. There is no fallback to any other
 * member's connection or to a token stored on the Data Connection.
 *
 * The token goes only to the instance that issued it. A GitLab address the
 * Data Connection was configured with (`config.baseUrl`, or the base URL a
 * discovered resource recorded) must name that same instance; anything else
 * is refused before a request is sent.
 */

import {
	describeGitLabConnectionFailure,
	getGitLabConnectionToken,
	gitlabApiBaseForOrigin,
	gitlabOriginOf,
	parseGitLabOrigin,
} from "@repo/integrations/gitlab";
import { ApplicationFailure } from "@temporalio/common";
import {
	GITLAB_SYNC_CONNECTION_REQUIRED,
	GITLAB_SYNC_ORIGIN_MISMATCH,
} from "../../../workflows/connector-sync/types";

/** The person a GitLab sync acts as: whoever started it. */
export type GitLabSyncActor = {
	userId?: string;
	organizationId?: string | null;
};

export type GitLabSyncCredential = {
	token: string;
	/** `https://host[:port]` of the instance that issued `token`. */
	origin: string;
	/** REST base every request of this activity is built on (`…/api/v4`). */
	apiBase: string;
};

function present(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * The REST base for a configured GitLab address that has already been
 * checked to be on `origin`. Keeps a sub-path install's path (`/gitlab`).
 */
function configuredApiBase(raw: string, origin: string): string {
	const trimmed = raw.trim();
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
	const path = new URL(withScheme).pathname.replace(/\/+$/, "");
	const base = `${origin}${path}`;
	return base.endsWith("/api/v4") ? base : `${base}/api/v4`;
}

/**
 * Resolve the acting person's GitLab connection for one sync activity.
 *
 * `configuredBaseUrls` are every GitLab address the Data Connection or the
 * resource being synced names (absent ones are skipped); each must be on the
 * credential's instance. The first present one decides the REST base;
 * without any, the credential's own instance is used.
 *
 * Throws a non-retryable `ApplicationFailure` when the sync cannot proceed
 * until the person acts (`GITLAB_SYNC_CONNECTION_REQUIRED`) or the address is
 * wrong (`GITLAB_SYNC_ORIGIN_MISMATCH`); a transient token failure is a plain
 * (retryable) error.
 */
export async function resolveGitLabSyncCredential(
	actor: GitLabSyncActor,
	configuredBaseUrls: readonly unknown[],
): Promise<GitLabSyncCredential> {
	if (!present(actor.userId)) {
		throw ApplicationFailure.nonRetryable(
			"A GitLab sync runs with the GitLab account of the person who starts it, and this run has none. Start the sync again from the connection page.",
			GITLAB_SYNC_CONNECTION_REQUIRED,
		);
	}

	// Check every configured address first: a refused one stops the sync
	// before the connection is even read.
	const configured: Array<{ raw: string; origin: string }> = [];
	for (const raw of configuredBaseUrls) {
		if (!present(raw)) {
			continue;
		}
		const checked = parseGitLabOrigin(raw);
		if (!checked.ok) {
			throw ApplicationFailure.nonRetryable(
				`This connection's GitLab address cannot be used: ${checked.reason}. Nothing was sent to it.`,
				GITLAB_SYNC_ORIGIN_MISMATCH,
			);
		}
		configured.push({ raw, origin: checked.origin });
	}

	const result = await getGitLabConnectionToken(
		{
			userId: actor.userId,
			organizationId: actor.organizationId ?? null,
		},
		// `anyOrigin`: every request below is checked against
		// `result.origin`, so a self-hosted credential only goes to its own
		// instance. `strict`: a token past its expiry whose refresh failed is
		// a failure here, not a request that is bound to be rejected.
		{ anyOrigin: true, mode: "strict" },
	);
	if (!result.ok) {
		const detail = describeGitLabConnectionFailure(result);
		if (result.reason === "transient") {
			throw new Error(
				`Your GitLab connection could not be read right now (${detail}).`,
			);
		}
		throw ApplicationFailure.nonRetryable(
			`Connect your GitLab account to sync this connection (${detail}).`,
			GITLAB_SYNC_CONNECTION_REQUIRED,
		);
	}

	const origin = gitlabOriginOf(result.origin) ?? result.origin;
	for (const entry of configured) {
		if (entry.origin !== origin) {
			throw ApplicationFailure.nonRetryable(
				`This connection's GitLab address (${entry.origin}) is not the GitLab instance your GitLab account is connected to (${origin}). Nothing was sent to it.`,
				GITLAB_SYNC_ORIGIN_MISMATCH,
			);
		}
	}

	const first = configured[0];
	return {
		token: result.accessToken,
		origin,
		apiBase: first
			? configuredApiBase(first.raw, origin)
			: gitlabApiBaseForOrigin(origin),
	};
}
