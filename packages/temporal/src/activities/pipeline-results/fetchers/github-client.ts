/**
 * Production GitHub REST client. Implements the
 * {@link GithubClient} the GitHub Actions fetcher depends on, authenticating
 * with a PAT / OAuth token via `Authorization: Bearer` and pinning the stable
 * `X-GitHub-Api-Version`. Auth lives here so the fetcher stays transport-
 * agnostic (tests inject a fixture-backed client).
 *
 * Artifact downloads are special: `GET .../artifacts/{id}/zip` answers `302`
 * with a short-lived signed URL on a different host (Azure Blob / codeload).
 * WHATWG `fetch` follows the redirect AND strips the `Authorization` header on
 * the cross-origin hop (the storage backend rejects a forwarded token), so a
 * plain follow returns the ZIP bytes. An expired artifact answers `410`, which
 * we surface as `null` (skip) rather than an error.
 */

import { requestAbortSignal } from "../../lib/activity-liveness";
import { readBoundedJson } from "./bounded-json";
import type { GithubClient } from "./github-actions-fetcher";
import {
	classifyProviderHttpFailure,
	ProviderHttpError,
} from "./provider-http-error";

/** Per-request bound. `fetch` has no default timeout; a stalled host would
 * otherwise hold the activity until its startToCloseTimeout. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Artifact/report downloads move real bytes, so they get a longer leash. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const GITHUB_API_BASE = "https://api.github.com";
/** Long-stable REST version; see GitHub's "API Versions" page before changing. */
const GITHUB_API_VERSION = "2022-11-28";

async function readBoundedBody(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null && Number(contentLength) > maxBytes) {
		throw new Error("GitHub artifact exceeds the download limit");
	}
	if (!response.body) {
		return new Uint8Array();
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error("GitHub artifact exceeds the download limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * Build a token-authenticated GitHub client. `apiBase` defaults to
 * api.github.com; a GitHub Enterprise Server host can override it (its REST API
 * lives under `https://<host>/api/v3`).
 */
export function createGithubTokenClient(
	token: string,
	apiBase: string = GITHUB_API_BASE,
): GithubClient {
	const base = apiBase.replace(/\/$/, "");
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	};

	return {
		async get<T>(path: string): Promise<T> {
			const res = await fetch(`${base}${path}`, {
				method: "GET",
				headers,
				signal: requestAbortSignal(REQUEST_TIMEOUT_MS),
			});
			if (res.status < 200 || res.status >= 300) {
				// The body is read on EVERY failure, including 401/403. It used to be
				// discarded for exactly those two, which is how a 403 became
				// undiagnosable: GitHub explains itself in plain English there
				// ("Resource protected by organization SAML enforcement", "API rate
				// limit exceeded for …") and that sentence was the one thing thrown
				// away.
				const body = await res.text().catch(() => "");
				const failure = classifyProviderHttpFailure({
					provider: "github",
					status: res.status,
					headers: res.headers,
					body,
					secrets: [token],
				});
				throw new ProviderHttpError({
					message: `GitHub request failed (${res.status}) for ${path}: ${failure.message}`,
					kind: failure.kind,
					status: res.status,
					providerDetail: failure.providerDetail,
				});
			}
			return await readBoundedJson<T>(res, "GitHub");
		},

		async getArtifactZip(path: string): Promise<Uint8Array | null> {
			const res = await fetch(`${base}${path}`, {
				method: "GET",
				headers,
				signal: requestAbortSignal(DOWNLOAD_TIMEOUT_MS),
				// Follow the 302 to the signed storage URL; fetch strips auth on the
				// cross-origin hop, which is exactly what the storage backend wants.
				redirect: "follow",
			});
			// The artifact expired (default 90-day retention) — not an error, just
			// no per-test detail for that run; ingest it as a run-level record.
			if (res.status === 410) {
				return null;
			}
			if (res.status < 200 || res.status >= 300) {
				throw new Error(
					`GitHub artifact download failed (${res.status}) for ${path}`,
				);
			}
			return readBoundedBody(res, MAX_ARTIFACT_BYTES);
		},
	};
}
