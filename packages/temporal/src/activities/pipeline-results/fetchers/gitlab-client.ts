/**
 * Production GitLab REST client. Implements the
 * {@link GitlabClient} the GitLab CI fetcher depends on, authenticating with a
 * personal / project access token via the `PRIVATE-TOKEN` header (the documented
 * GitLab scheme; a `read_api`-scoped token suffices). Auth lives here so the
 * fetcher stays transport-agnostic (tests inject a fixture-backed client).
 *
 * The API base is derived from the connected repo's host, so gitlab.com and a
 * self-managed GitLab both work: `https://<host>/api/v4`.
 */

import { safeFetchOutbound } from "@repo/utils/url-security";
import { requestAbortSignal } from "../../lib/activity-liveness";
import { readBoundedJson } from "./bounded-json";
import type { GitlabClient } from "./gitlab-ci-fetcher";
import {
	classifyProviderHttpFailure,
	ProviderHttpError,
} from "./provider-http-error";

/** Per-request bound. `fetch` has no default timeout; a stalled host would
 * otherwise hold the activity until its startToCloseTimeout. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Build a token-authenticated GitLab client rooted at `<apiBase>` (e.g.
 * `https://gitlab.com/api/v4`). The fetcher issues paths beginning
 * `/projects/...`.
 */
export function createGitlabTokenClient(
	apiBase: string,
	token: string,
): GitlabClient {
	const base = apiBase.replace(/\/$/, "");

	return {
		async get<T>(path: string): Promise<T> {
			const res = await safeFetchOutbound(`${base}${path}`, {
				method: "GET",
				headers: {
					"PRIVATE-TOKEN": token,
					Accept: "application/json",
				},
				signal: requestAbortSignal(REQUEST_TIMEOUT_MS),
			});
			if (res.status < 200 || res.status >= 300) {
				// Body read on every failure — see the note in `github-client.ts`.
				// GitLab's 403 is likewise not automatically a credential problem:
				// it answers 429 with `retry-after` when rate limited, and a
				// project-level permission refusal is not fixed by reconnecting.
				const body = await res.text().catch(() => "");
				const failure = classifyProviderHttpFailure({
					provider: "gitlab",
					status: res.status,
					headers: res.headers,
					body,
					secrets: [token],
				});
				throw new ProviderHttpError({
					message: `GitLab request failed (${res.status}) for ${path}: ${failure.message}`,
					kind: failure.kind,
					status: res.status,
					providerDetail: failure.providerDetail,
				});
			}
			return await readBoundedJson<T>(res, "GitLab");
		},
	};
}

/**
 * The SSRF-guarded GitLab REST base for a connected repo. The canonical
 * definition lives in `@repo/integrations/ci-trigger`, which the API also uses to
 * START pipelines — one guard for both directions, so the host allow-rules cannot
 * drift between the path that reads runs and the path that creates them.
 */
export { gitlabPipelineApiBase as gitlabApiBaseFromRepoUrl } from "@repo/integrations/ci-trigger";
