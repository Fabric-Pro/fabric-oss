/**
 * Start a GitHub Actions run via `workflow_dispatch`.
 *
 * GitHub is the one provider that needs something from the customer: a workflow
 * can only be dispatched if its file already declares `on: workflow_dispatch:`.
 * Fabric will not add that for them — writing CI config is out of scope — so the
 * job here is to detect the two ways this fails and name them precisely:
 *
 *  - `422` with a `workflow_dispatch` message → their workflow is not dispatchable
 *  - `403` (with quota remaining) → our token has read scope but not `actions:write`
 *
 * Both were previously indistinguishable from "GitHub said no", which left the
 * user with nothing to act on.
 */

import { ciRequestSignal, isRateLimited, readErrorBody } from "./http";
import type { CiTriggerResult, TriggerablePipeline } from "./types";

const GITHUB_API_BASE = "https://api.github.com";
/** Long-stable REST version; see GitHub's "API Versions" page before changing. */
const GITHUB_API_VERSION = "2022-11-28";

function githubHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	};
}

interface GithubWorkflow {
	id: number;
	name: string;
	path: string;
	state: string;
	html_url: string;
}

/**
 * List the workflows Fabric could dispatch on a repo. Whether a given workflow
 * actually declares `workflow_dispatch:` is NOT determined here: answering that
 * needs the workflow file's YAML, and GitHub already answers it authoritatively
 * at dispatch time with a 422. One list call plus a precise error beats fetching
 * and parsing every workflow file to pre-empt it.
 *
 * `active` is the only state offered — a disabled workflow cannot run at all.
 */
export async function listGithubWorkflows(input: {
	token: string;
	owner: string;
	repo: string;
}): Promise<TriggerablePipeline[]> {
	const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(
		input.repo,
	)}/actions/workflows?per_page=100`;

	const res = await fetch(`${GITHUB_API_BASE}${path}`, {
		method: "GET",
		headers: githubHeaders(input.token),
		signal: ciRequestSignal(),
	});
	if (res.status < 200 || res.status >= 300) {
		throw new Error(
			`GitHub workflow listing failed (${res.status})${
				res.status === 401 || res.status === 403
					? " — check the connected GitHub token"
					: ""
			}`,
		);
	}

	const body = (await res.json()) as { workflows?: GithubWorkflow[] };
	return (body.workflows ?? [])
		.filter((w) => w.state === "active")
		.map((w) => ({
			id: String(w.id),
			name: w.name,
			path: w.path,
			url: w.html_url,
		}));
}

/**
 * Dispatch a workflow run on `ref`. A success answers `204 No Content` with no
 * run id — GitHub creates the run asynchronously — so the caller gets the
 * workflow's own page to watch instead, and the run itself arrives through the
 * normal pipeline-results sync.
 *
 * `inputs` is best-effort scoping: it only reaches the test command
 * if the customer's workflow declares matching `workflow_dispatch.inputs` and
 * passes them through. GitHub rejects unknown input keys with a 422, which is
 * surfaced verbatim rather than swallowed.
 */
export async function triggerGithubWorkflow(input: {
	token: string;
	owner: string;
	repo: string;
	/** Numeric workflow id or the workflow file name, per GitHub's API. */
	workflowId: string;
	ref: string;
	inputs?: Record<string, string>;
}): Promise<CiTriggerResult> {
	const owner = encodeURIComponent(input.owner);
	const repo = encodeURIComponent(input.repo);
	const workflow = encodeURIComponent(input.workflowId);
	const path = `/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;

	const res = await fetch(`${GITHUB_API_BASE}${path}`, {
		method: "POST",
		headers: {
			...githubHeaders(input.token),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			ref: input.ref,
			...(input.inputs && Object.keys(input.inputs).length > 0
				? { inputs: input.inputs }
				: {}),
		}),
		signal: ciRequestSignal(),
	});

	if (res.status === 204) {
		return {
			ok: true,
			// GitHub returns no id for a dispatch; the run appears on the next sync.
			runId: null,
			// Encoded like the API path above, not raw — the scheme is fixed so
			// this can never become a `javascript:` link, but it is rendered as an
			// href and an unencoded segment would simply produce a broken one.
			runUrl: `https://github.com/${owner}/${repo}/actions/workflows/${workflow}`,
		};
	}

	// Checked before the 403 branch: GitHub reuses 403 for throttling, and
	// reporting a rate limit as a missing scope sends the user to reissue a token
	// that was never the problem.
	if (isRateLimited(res)) {
		return {
			ok: false,
			failure: "RATE_LIMITED",
			message:
				"GitHub is rate-limiting Fabric right now. Wait a few minutes and start the run again.",
		};
	}

	const detail = await readErrorBody(res, [input.token]);

	if (res.status === 422 && detail.includes("workflow_dispatch")) {
		return {
			ok: false,
			failure: "NOT_DISPATCHABLE",
			message:
				"That GitHub workflow cannot be started from outside GitHub: its file does not declare a `workflow_dispatch:` trigger. Add `workflow_dispatch:` under `on:` in the workflow and try again — Fabric does not modify your CI configuration.",
		};
	}

	// A revoked, expired or malformed token answers 401, not 403. Without this
	// branch it fell through to the generic provider error and the user was told
	// "GitHub could not start the run (401)" — true, useless, and pointing at the
	// wrong remedy. `listGithubWorkflows` above already distinguishes the two.
	if (res.status === 401) {
		return {
			ok: false,
			failure: "INSUFFICIENT_SCOPE",
			message:
				"GitHub rejected the connected credential. It has most likely been revoked or has expired — reconnect the repository in Project Settings.",
		};
	}

	if (res.status === 403) {
		return {
			ok: false,
			failure: "INSUFFICIENT_SCOPE",
			message:
				// Naming only one of these sends half of users to check a setting
				// they do not have: the scope is spelled differently for each of
				// GitHub's three credential types.
				"The connected GitHub credential can read CI results but cannot start runs. Starting a workflow needs write access to Actions — `actions:write` on a fine-grained token, the `workflow` scope on a classic token, or the Actions: Read and write permission for a GitHub App. Reconnect the repository with a credential that has it.",
		};
	}

	if (res.status === 404) {
		return {
			ok: false,
			failure: "NOT_FOUND",
			message: `GitHub could not find that workflow on ${input.owner}/${input.repo}, or the connected credential cannot see it. Check the workflow still exists and that the token has access to the repository.`,
		};
	}

	if (res.status === 422) {
		return {
			ok: false,
			failure: "PROVIDER_ERROR",
			message: `GitHub rejected the run: ${detail || "the ref or the workflow inputs were not accepted."}`,
		};
	}

	return {
		ok: false,
		failure: "PROVIDER_ERROR",
		message: `GitHub could not start the run (${res.status})${detail ? `: ${detail}` : "."}`,
	};
}
