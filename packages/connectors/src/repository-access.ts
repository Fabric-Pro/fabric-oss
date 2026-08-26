/**
 * Repository access probe (request-path helper)
 *
 * Answers the question the connection badge actually asks: can THIS credential
 * read THIS repository. Sibling of `verifyRepositoryBranch`, which verifies one
 * branch; this one observes the repository itself, so an App that is not
 * installed on the repo (or a token scoped away from it) is caught at the
 * moment the credential is stored instead of surfacing later as failed reads.
 *
 * Outcomes are a closed set the caller maps to statuses/errors:
 *  - "accessible"   — the credential read the repository.
 *  - "unauthorized" — the credential itself was rejected (401). Reconnecting
 *                     is the remedy.
 *  - "forbidden"    — the credential authenticated but was refused the
 *                     repository (403). Reconnecting adds nothing; the app must
 *                     be installed on the repository or the token granted it.
 *  - "not-found"    — the provider answered 404: the repository does not exist
 *                     OR is invisible to this credential (both answer 404).
 *  - "unreachable"  — network failure or a 5xx-class upstream error. Says
 *                     nothing about access; callers keep today's behaviour.
 *
 * SECURITY: the token is request-scoped — NEVER logged, NEVER returned — and
 * raw provider response bodies are never surfaced. The helper never throws.
 */

import { parseAdoRepositoryUrl } from "./repository-branch";

export type RepoAccessOutcome =
	| "accessible"
	| "unauthorized"
	| "forbidden"
	| "not-found"
	| "unreachable";

/**
 * What verifyRepositoryAccess resolves to. The outcome is the verdict; a
 * successful probe also returns the provider's own default branch so callers
 * can skip their second identical fetch (connect flows resolve the branch
 * right after probing — same endpoint, same payload).
 */
export interface RepoAccessResult {
	outcome: RepoAccessOutcome;
	defaultBranch?: string;
}

export interface VerifyRepositoryAccessInput {
	provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS";
	/** Decrypted access token or PAT (request-scoped, never logged). */
	token: string;
	/** Canonical repository URL — the ADO org/project come from it. */
	repositoryUrl: string;
	owner: string;
	repo: string;
	azureOrganization?: string | null;
	/**
	 * GitLab authenticates OAuth tokens with `Authorization: Bearer` and PATs
	 * with `PRIVATE-TOKEN`; the wrong one reads as a rejected credential.
	 * Every other provider takes the token as a Bearer header regardless.
	 */
	gitlabAuth?: "bearer" | "private-token";
}

/**
 * Map an HTTP status to an access outcome shared by all three providers.
 *
 * A rate-limit wall (429, or 403 with the quota exhausted / a retry-after)
 * is NOT a verdict about access — the same token succeeds after the window —
 * so it resolves to `unreachable`, matching how both sibling lanes (the sweep's
 * account-level probes and checkPatHealth) already refuse to classify quota
 * answers as credential or permission failures.
 */
function accessFromStatus(
	status: number,
	headers: Headers | Record<string, string>,
): RepoAccessOutcome {
	if (status === 401) {
		return "unauthorized";
	}
	if (status === 429 || (status === 403 && isRateLimitWall(headers))) {
		return "unreachable";
	}
	if (status === 403) {
		return "forbidden";
	}
	if (status === 404) {
		return "not-found";
	}
	return "unreachable";
}

/** GitHub's primary limiter zeroes `x-ratelimit-remaining`; the secondary one sends `retry-after`. */
function isRateLimitWall(headers: Headers | Record<string, string>): boolean {
	const read = (name: string): string | null =>
		typeof (headers as Headers).get === "function"
			? (headers as Headers).get(name)
			: ((headers as Record<string, string>)[name] ?? null);
	if (read("retry-after") !== null) {
		return true;
	}
	const remaining = read("x-ratelimit-remaining");
	return remaining !== null && Number.parseInt(remaining, 10) === 0;
}

async function probeGitHub(
	input: VerifyRepositoryAccessInput,
): Promise<RepoAccessResult> {
	const url = `https://api.github.com/repos/${encodeURIComponent(
		input.owner,
	)}/${encodeURIComponent(input.repo)}`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${input.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "Fabric-Platform",
		},
		signal: AbortSignal.timeout(5000),
	});
	if (response.ok) {
		const body = (await response.json().catch(() => null)) as {
			default_branch?: string;
		} | null;
		return { outcome: "accessible", defaultBranch: body?.default_branch };
	}
	return {
		outcome: accessFromStatus(response.status, response.headers),
	};
}

async function probeGitLab(
	input: VerifyRepositoryAccessInput,
): Promise<RepoAccessResult> {
	// Pinned to gitlab.com like the PAT validators — `parseRepoUrl` recognises
	// GitLab by hostname, so the stored URL cannot name another host, and pinning
	// keeps this authenticated request off internal networks (SSRF).
	const projectPath = encodeURIComponent(`${input.owner}/${input.repo}`);
	const url = `https://gitlab.com/api/v4/projects/${projectPath}`;
	const headers: Record<string, string> =
		input.gitlabAuth === "private-token"
			? { "PRIVATE-TOKEN": input.token }
			: { Authorization: `Bearer ${input.token}` };
	const response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(5000),
	});
	if (response.ok) {
		const body = (await response.json().catch(() => null)) as {
			default_branch?: string;
		} | null;
		return { outcome: "accessible", defaultBranch: body?.default_branch };
	}
	return {
		outcome: accessFromStatus(response.status, response.headers),
	};
}

async function probeAzureDevOps(
	input: VerifyRepositoryAccessInput,
): Promise<RepoAccessResult> {
	const parsed = parseAdoRepositoryUrl(input.repositoryUrl);
	const organization = parsed?.organization ?? input.azureOrganization;
	if (!organization) {
		return { outcome: "unreachable" };
	}
	const host = parsed?.host ?? "https://dev.azure.com";
	const projectSegment = parsed
		? `/${encodeURIComponent(parsed.project)}`
		: "";
	let repoName: string;
	try {
		repoName = decodeURIComponent(input.repo);
	} catch {
		repoName = input.repo;
	}
	const url = `${host}/${encodeURIComponent(
		organization,
	)}${projectSegment}/_apis/git/repositories/${encodeURIComponent(repoName)}?api-version=7.1`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Basic ${Buffer.from(`:${input.token}`).toString("base64")}`,
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(5000),
	});
	// ADO answers an invalid/expired PAT with a 203 + HTML sign-in page rather
	// than a clean 401 — treat it as the credential failure it is.
	if (response.status === 203) {
		return { outcome: "unauthorized" };
	}
	if (response.ok) {
		return { outcome: "accessible" };
	}
	return { outcome: accessFromStatus(response.status, response.headers) };
}

/**
 * Probe whether `token` can read the repository at `owner`/`repo`. Never
 * throws — network and parse failures resolve as `"unreachable"`.
 */
export async function verifyRepositoryAccess(
	input: VerifyRepositoryAccessInput,
): Promise<RepoAccessResult> {
	try {
		switch (input.provider) {
			case "GITHUB":
				return await probeGitHub(input);
			case "GITLAB":
				return await probeGitLab(input);
			case "AZURE_DEVOPS":
				return await probeAzureDevOps(input);
			default:
				return { outcome: "unreachable" };
		}
	} catch {
		return { outcome: "unreachable" };
	}
}
