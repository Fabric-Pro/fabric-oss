/**
 * Start a GitLab CI pipeline.
 *
 * GitLab needs no configuration change and offers nothing to pick: a pipeline is
 * created for a ref, from the `.gitlab-ci.yml` that exists on that ref. The one
 * real failure to name is the scope — `read_api` is enough to READ pipelines
 * (which is what Fabric's ingestion uses today) but not to create one, which
 * needs `api`. That distinction is invisible in GitLab's own 403 body.
 */

import { safeFetchOutbound } from "@repo/utils/url-security";
import {
	ciRequestSignal,
	gitlabApiBaseFromRepoUrl,
	isRateLimited,
	readErrorBody,
	safeRunUrl,
} from "./http";
import type { CiTriggerResult } from "./types";

interface GitlabPipelineResponse {
	id?: number;
	web_url?: string;
}

/**
 * Create a pipeline on `ref`. `variables` is best-effort scoping:
 * GitLab accepts arbitrary variables, but they only narrow the run if the
 * customer's `.gitlab-ci.yml` reads them.
 */
export async function triggerGitlabPipeline(input: {
	token: string;
	/** REST base, e.g. `https://gitlab.com/api/v4` — see {@link gitlabPipelineApiBase}. */
	apiBase: string;
	/** Namespaced project path, e.g. `acme/store`. */
	projectPath: string;
	ref: string;
	variables?: Record<string, string>;
}): Promise<CiTriggerResult> {
	const base = input.apiBase.replace(/\/$/, "");
	const path = `/projects/${encodeURIComponent(input.projectPath)}/pipeline`;

	const res = await safeFetchOutbound(`${base}${path}`, {
		method: "POST",
		headers: {
			"PRIVATE-TOKEN": input.token,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			ref: input.ref,
			...(input.variables && Object.keys(input.variables).length > 0
				? {
						variables: Object.entries(input.variables).map(
							([key, value]) => ({ key, value }),
						),
					}
				: {}),
		}),
		signal: ciRequestSignal(),
	});

	if (res.status === 200 || res.status === 201) {
		const body = (await res.json()) as GitlabPipelineResponse;
		return {
			ok: true,
			runId: body.id != null ? String(body.id) : null,
			// The host is customer-controlled (self-managed GitLab is supported)
			// and this ends up as a clickable href.
			runUrl: safeRunUrl(body.web_url),
		};
	}

	if (isRateLimited(res)) {
		return {
			ok: false,
			failure: "RATE_LIMITED",
			message:
				"GitLab is rate-limiting Fabric right now. Wait a few minutes and start the run again.",
		};
	}

	const detail = await readErrorBody(res, [input.token]);

	if (res.status === 401 || res.status === 403) {
		return {
			ok: false,
			failure: "INSUFFICIENT_SCOPE",
			message:
				"The connected GitLab token can read pipelines but cannot create one. Starting a pipeline needs the `api` scope, not just `read_api` — reconnect the repository with a token that has it.",
		};
	}

	if (res.status === 404) {
		return {
			ok: false,
			failure: "NOT_FOUND",
			message: `GitLab could not find the project ${input.projectPath}, or the connected token cannot see it.`,
		};
	}

	// GitLab uses 400 for a missing ref and for a ref with no `.gitlab-ci.yml`,
	// but ALSO for unrelated validation failures — a malformed variable key, for
	// instance. Classifying every 400 as NOT_FOUND told a user their branch was
	// missing when their branch was fine, so the ref-specific verdict is only
	// claimed when GitLab's own body points that way. Either way the body is
	// quoted: it is the most useful thing available.
	if (res.status === 400) {
		// Match GitLab's OWN phrasing, not loose keywords. The body echoes back
		// caller-supplied variable KEYS, so a substring test for `ref`/`branch`/
		// `sha` is decided by what the user named their variable: a key called
		// `BRANCH_OVERRIDE` would make an invalid-variable error report itself as
		// a missing ref, and `sha` matches inside "shard". These two phrases are
		// what GitLab actually returns for the ref cases, and neither can appear
		// in a variable key, which cannot contain spaces or a dot.
		const blamesTheRef = /reference not found|\.gitlab-ci\.yml/i.test(
			detail,
		);
		return {
			ok: false,
			failure: blamesTheRef ? "NOT_FOUND" : "PROVIDER_ERROR",
			message: `GitLab rejected the pipeline for ref "${input.ref}": ${
				detail ||
				"the ref may not exist, or it has no .gitlab-ci.yml to run."
			}`,
		};
	}

	return {
		ok: false,
		failure: "PROVIDER_ERROR",
		message: `GitLab could not start the pipeline (${res.status})${detail ? `: ${detail}` : "."}`,
	};
}

/**
 * The GitLab REST base for a connected repo, SSRF-guarded. Re-exported from the
 * shared transport so the trigger path and the results-fetch path apply exactly
 * the same host guard.
 */
export { gitlabApiBaseFromRepoUrl as gitlabPipelineApiBase };
