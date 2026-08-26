/**
 * Production Azure DevOps REST client. Implements the {@link AdoClient}
 * the fetcher depends on, authenticating with a Personal Access Token via HTTP
 * Basic auth (`Authorization: Basic base64(":" + PAT)`) — the documented ADO PAT
 * scheme. Auth lives here so the fetcher stays transport-agnostic (tests inject a
 * fixture-backed client; a local harness injects `az rest`).
 *
 * Bad or missing credentials make ADO answer with a 302 to the sign-in page (an
 * HTML body that would explode `res.json()`), so redirects are NOT followed and
 * any non-2xx status is surfaced as an explicit error the sync activity records.
 */

import { requestAbortSignal } from "../../lib/activity-liveness";
import type { AdoClient } from "./azure-devops-fetcher";
import { readBoundedJson } from "./bounded-json";
import {
	classifyProviderHttpFailure,
	ProviderHttpError,
} from "./provider-http-error";

/** Per-request bound. `fetch` has no default timeout; a stalled host would
 * otherwise hold the activity until its startToCloseTimeout. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Build a PAT-authenticated ADO client rooted at `https://dev.azure.com/{org}`.
 * The fetcher issues paths beginning `/{project}/_apis/...`, so only the org sits
 * in the base URL.
 */
export function createAdoPatClient(
	organization: string,
	pat: string,
): AdoClient {
	const base = `https://dev.azure.com/${encodeURIComponent(organization)}`;
	const auth = Buffer.from(`:${pat}`).toString("base64");

	return {
		async get<T>(path: string): Promise<T> {
			const res = await fetch(`${base}${path}`, {
				method: "GET",
				headers: {
					Authorization: `Basic ${auth}`,
					Accept: "application/json",
				},
				signal: requestAbortSignal(REQUEST_TIMEOUT_MS),
				// A 302 to the sign-in page means the PAT is rejected — treat it as an
				// auth error rather than parsing the login HTML as JSON.
				redirect: "manual",
			});
			if (res.status < 200 || res.status >= 300) {
				const body = await res.text().catch(() => "");
				// 302 and 203 are Azure DevOps' own way of saying "bad PAT": it
				// answers a rejected PAT with a redirect to, or the body of, the
				// sign-in page rather than a 401. Mapped onto 401 so the shared
				// classifier gives the same "reconnect" advice for all three, while
				// every other status — including 429, which ADO does use for
				// throttling with a `Retry-After` — is classified on its merits
				// instead of being called an auth failure.
				const failure = classifyProviderHttpFailure({
					provider: "azure-devops",
					status:
						res.status === 302 || res.status === 203
							? 401
							: res.status,
					headers: res.headers,
					body,
					secrets: [pat, auth],
				});
				throw new ProviderHttpError({
					message: `Azure DevOps request failed (${res.status}) for ${path}: ${failure.message}`,
					kind: failure.kind,
					status: res.status,
					providerDetail: failure.providerDetail,
				});
			}
			return await readBoundedJson<T>(res, "Azure DevOps");
		},
	};
}
