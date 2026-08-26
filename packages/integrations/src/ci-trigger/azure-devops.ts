/**
 * Queue an Azure DevOps build.
 *
 * ADO needs no configuration change, but it does need a build definition to
 * queue — unlike GitLab, where the ref alone is enough. A PAT scoped only to
 * "Build (read)" can list definitions and will then fail to queue one, so the
 * two calls here fail differently on purpose.
 *
 * ADO answers a rejected PAT with a `203` (or a `302` to the sign-in page) and an
 * HTML body rather than a 401, which is why the status checks below are wider
 * than they look — this mirrors the read client in the pipeline-results fetcher.
 */

import {
	ciRequestSignal,
	isRateLimited,
	readErrorBody,
	safeRunUrl,
} from "./http";
import type { CiTriggerResult, TriggerablePipeline } from "./types";

/** ADO pins behaviour to an explicit API version on every call. */
const ADO_API_VERSION = "7.1";

function adoBase(organization: string): string {
	return `https://dev.azure.com/${encodeURIComponent(organization)}`;
}

function adoAuthHeader(pat: string): string {
	return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

/** True for the several shapes ADO uses to say "this credential is no good". */
function isAdoAuthRejection(status: number): boolean {
	return status === 203 || status === 302 || status === 401;
}

interface AdoBuildDefinition {
	id: number;
	name: string;
	path?: string;
	_links?: { web?: { href?: string } };
}

interface AdoQueuedBuild {
	id?: number;
	_links?: { web?: { href?: string } };
}

/**
 * List the build definitions in an ADO project that a run could be queued
 * against, most recently modified first — the one a QA user wants is nearly
 * always among the last touched.
 */
export async function listAdoBuildDefinitions(input: {
	pat: string;
	organization: string;
	project: string;
}): Promise<TriggerablePipeline[]> {
	const path = `/${encodeURIComponent(input.project)}/_apis/build/definitions?api-version=${ADO_API_VERSION}&queryOrder=lastModifiedDescending&$top=100`;

	const res = await fetch(`${adoBase(input.organization)}${path}`, {
		method: "GET",
		headers: {
			Authorization: adoAuthHeader(input.pat),
			Accept: "application/json",
		},
		signal: ciRequestSignal(),
		// A 302 to the sign-in page means the PAT was rejected — do not follow it
		// and parse the login HTML as JSON.
		redirect: "manual",
	});
	// 203 is IN the 2xx range and is how ADO reports a rejected PAT, so the auth
	// check cannot be folded into a plain status-range test — doing that lets the
	// sign-in HTML reach `res.json()` and surfaces "Unexpected token '<'" instead
	// of "check your PAT".
	if (
		isAdoAuthRejection(res.status) ||
		res.status < 200 ||
		res.status >= 300
	) {
		throw new Error(
			`Azure DevOps definition listing failed (${res.status})${
				isAdoAuthRejection(res.status) || res.status === 403
					? " — check the connected PAT and its Build scope"
					: ""
			}`,
		);
	}

	const body = (await res.json()) as { value?: AdoBuildDefinition[] };
	return (body.value ?? []).map((d) => ({
		id: String(d.id),
		name: d.name,
		// ADO folders definitions under a path; "\\" is its root and carries no
		// information, so it reads as no path at all.
		path: d.path && d.path !== "\\" ? d.path : null,
		url: d._links?.web?.href ?? null,
	}));
}

/**
 * Queue a build for `definitionId` on `sourceBranch`. `parameters` is best-effort
 * scoping — ADO passes them to the pipeline as variables, and they
 * only narrow the run if the customer's pipeline declares matching parameters.
 */
export async function triggerAdoBuild(input: {
	pat: string;
	organization: string;
	project: string;
	definitionId: string;
	/** Full ref (`refs/heads/main`) or a bare branch name, which is normalized. */
	sourceBranch: string;
	parameters?: Record<string, string>;
}): Promise<CiTriggerResult> {
	const numericDefinitionId = Number(input.definitionId);
	if (!Number.isInteger(numericDefinitionId)) {
		return {
			ok: false,
			failure: "NOT_FOUND",
			message: `"${input.definitionId}" is not a valid Azure DevOps build definition id.`,
		};
	}

	const path = `/${encodeURIComponent(input.project)}/_apis/build/builds?api-version=${ADO_API_VERSION}`;
	const res = await fetch(`${adoBase(input.organization)}${path}`, {
		method: "POST",
		headers: {
			Authorization: adoAuthHeader(input.pat),
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			definition: { id: numericDefinitionId },
			sourceBranch: normalizeAdoRef(input.sourceBranch),
			...(input.parameters && Object.keys(input.parameters).length > 0
				? { parameters: JSON.stringify(input.parameters) }
				: {}),
		}),
		signal: ciRequestSignal(),
		redirect: "manual",
	});

	if (
		res.status >= 200 &&
		res.status < 300 &&
		!isAdoAuthRejection(res.status)
	) {
		const body = (await res.json()) as AdoQueuedBuild;
		return {
			ok: true,
			runId: body.id != null ? String(body.id) : null,
			// Provider-supplied, and this ends up as a clickable href.
			runUrl: safeRunUrl(body._links?.web?.href),
		};
	}

	if (isRateLimited(res)) {
		return {
			ok: false,
			failure: "RATE_LIMITED",
			message:
				"Azure DevOps is rate-limiting Fabric right now. Wait a few minutes and start the run again.",
		};
	}

	// Both forms: the PAT itself, and the base64 header value ADO is sent, since
	// a proxy that echoes the request headers reflects the encoded one.
	const detail = await readErrorBody(res, [
		input.pat,
		adoAuthHeader(input.pat),
	]);

	// 403 means the PAT is valid but under-scoped; 203/302/401 mean ADO rejected
	// the PAT outright (expired, revoked, wrong org). Telling someone to add a
	// scope to a credential that no longer exists sends them to the wrong screen,
	// so the two are worded separately even though both are INSUFFICIENT_SCOPE.
	if (res.status === 403) {
		return {
			ok: false,
			failure: "INSUFFICIENT_SCOPE",
			message:
				"The connected Azure DevOps PAT cannot queue builds. Queuing needs the Build (read and execute) scope — reconnect the repository with a PAT that has it.",
		};
	}

	if (isAdoAuthRejection(res.status)) {
		return {
			ok: false,
			failure: "INSUFFICIENT_SCOPE",
			message:
				"Azure DevOps rejected the connected PAT. It has most likely expired or been revoked — reconnect the repository in Project Settings, with the Build (read and execute) scope.",
		};
	}

	if (res.status === 404) {
		return {
			ok: false,
			failure: "NOT_FOUND",
			message: `Azure DevOps could not find build definition ${input.definitionId} in project ${input.project}, or the connected PAT cannot see it.`,
		};
	}

	return {
		ok: false,
		failure: "PROVIDER_ERROR",
		message: `Azure DevOps could not queue the build (${res.status})${detail ? `: ${detail}` : "."}`,
	};
}

/**
 * ADO's queue API wants a full ref. Fabric stores QA branches as bare names
 * (`main`), which ADO silently accepts and then builds the wrong thing, so the
 * `refs/heads/` prefix is added here rather than trusted from the caller.
 */
function normalizeAdoRef(branch: string): string {
	const trimmed = branch.trim();
	return trimmed.startsWith("refs/") ? trimmed : `refs/heads/${trimmed}`;
}
