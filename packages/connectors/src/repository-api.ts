import {
	azureDevOpsHeaders,
	gitlabHeaders,
	gitlabHost,
	parseAdoRepositoryUrl,
} from "./repository-address";
import { readCappedRepositoryBody } from "./repository-body";
import type { VerifyRepositoryBranchInput } from "./repository-branch";

/**
 * What the request-path repository readers that ask the provider about
 * COMMITS share (`repository-commits.ts`, `repository-compare.ts`; Fizzy
 * #2878 §10): the API base and auth headers per provider, the provider's own
 * link to a commit, and one bounded JSON GET with the closed failure set the
 * sibling helpers (`repository-tree.ts`, `repository-file.ts`) use.
 *
 * The hosts are the ones the siblings use and no other: GitHub's API, the
 * pinned `gitlab.com` (see `gitlabHost`), and Azure DevOps through the host
 * the stored repository URL names (`parseAdoRepositoryUrl` only accepts
 * `dev.azure.com` and `{org}.visualstudio.com`). A caller-supplied URL never
 * becomes a fetch origin, because every request carries a live token.
 *
 * SECURITY: the token is request-scoped, never logged, never returned, and
 * raw provider bodies are never surfaced.
 */

export type RepositoryApiInput = Omit<VerifyRepositoryBranchInput, "branch">;

export type RepositoryFailure = "not-found" | "unauthorized" | "unreachable";

export type RepositoryApiTarget = {
	provider: RepositoryApiInput["provider"];
	/** The repository's API root, no trailing slash. */
	base: string;
	headers: Record<string, string>;
	signal?: AbortSignal;
	/** The provider's web page for one commit. */
	commitUrl(sha: string): string;
	pullRequestUrl(number: number): string;
};

export const AZURE_DEVOPS_API_VERSION = "7.1";
const REQUEST_TIMEOUT_MS = 10_000;
/** The most bytes of one provider answer read; a longer one is `unreachable`. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** The API target for the input's repository, or null when it cannot be addressed (no Azure DevOps organization). */
export function repositoryApiTarget(
	input: RepositoryApiInput,
): RepositoryApiTarget | null {
	switch (input.provider) {
		case "GITHUB": {
			const repository = `${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
			return {
				provider: "GITHUB",
				signal: input.signal,
				base: `https://api.github.com/repos/${repository}`,
				headers: {
					Authorization: `Bearer ${input.token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				commitUrl: (sha) =>
					`https://github.com/${repository}/commit/${sha}`,
				pullRequestUrl: (number) =>
					`https://github.com/${repository}/pull/${number}`,
			};
		}
		case "GITLAB": {
			const host = gitlabHost();
			const path = `${input.owner}/${input.repo}`;
			return {
				provider: "GITLAB",
				signal: input.signal,
				base: `${host}/api/v4/projects/${encodeURIComponent(path)}`,
				headers: gitlabHeaders(input),
				commitUrl: (sha) =>
					`${host}/${path.split("/").map(encodeURIComponent).join("/")}/-/commit/${sha}`,
				pullRequestUrl: (number) =>
					`${host}/${path.split("/").map(encodeURIComponent).join("/")}/-/merge_requests/${number}`,
			};
		}
		case "AZURE_DEVOPS": {
			const parsed = parseAdoRepositoryUrl(input.repositoryUrl);
			const organization =
				parsed?.organization ?? input.azureOrganization;
			if (!organization) {
				return null;
			}
			const host = parsed?.host ?? "https://dev.azure.com";
			const modernHost = host === "https://dev.azure.com";
			const projectSegment = parsed
				? `/${encodeURIComponent(parsed.project)}`
				: "";
			// Stored RAW from the connect URL: decode once, then encode once.
			let repoName: string;
			try {
				repoName = decodeURIComponent(input.repo);
			} catch {
				repoName = input.repo;
			}
			const root = `${host}${modernHost ? `/${encodeURIComponent(organization)}` : ""}${projectSegment}`;
			return {
				provider: "AZURE_DEVOPS",
				signal: input.signal,
				base: `${root}/_apis/git/repositories/${encodeURIComponent(repoName)}`,
				headers: azureDevOpsHeaders(input),
				commitUrl: (sha) =>
					`${root}/_git/${encodeURIComponent(repoName)}/commit/${sha}`,
				pullRequestUrl: (number) =>
					`${root}/_git/${encodeURIComponent(repoName)}/pullrequest/${number}`,
			};
		}
		default: {
			const unreachable: never = input.provider;
			return unreachable;
		}
	}
}

function failureFromStatus(status: number): RepositoryFailure {
	if (status === 401 || status === 403) {
		return "unauthorized";
	}
	if (status === 404) {
		return "not-found";
	}
	return "unreachable";
}

export type RepositoryJson =
	| { ok: true; data: unknown }
	| { ok: false; outcome: RepositoryFailure };

export function repositoryRequestSignal(
	timeoutMs: number,
	signal?: AbortSignal,
): AbortSignal {
	signal?.throwIfAborted();
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * One GET on the repository's API, parsed as JSON. Never throws: a network
 * failure, a timeout, an oversize or non-JSON body is `unreachable`; Azure
 * DevOps's 203 sign-in page for a rejected token is `unauthorized`.
 */
export async function getRepositoryJson(
	target: RepositoryApiTarget,
	pathAndQuery: string,
	options: { timeoutMs?: number } = {},
): Promise<RepositoryJson> {
	let response: Response;
	try {
		response = await fetch(`${target.base}${pathAndQuery}`, {
			headers: target.headers,
			signal: repositoryRequestSignal(
				options.timeoutMs ?? REQUEST_TIMEOUT_MS,
				target.signal,
			),
		});
	} catch {
		return { ok: false, outcome: "unreachable" };
	}
	if (response.status === 203) {
		return { ok: false, outcome: "unauthorized" };
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		return { ok: false, outcome: failureFromStatus(response.status) };
	}
	try {
		const body = await readCappedRepositoryBody(
			response,
			MAX_RESPONSE_BYTES,
			{
				refuseDeclaredLength: true,
			},
		);
		if (!body.complete) {
			return { ok: false, outcome: "unreachable" };
		}
		return {
			ok: true,
			data: JSON.parse(Buffer.from(body.bytes).toString("utf8")),
		};
	} catch {
		return { ok: false, outcome: "unreachable" };
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(
	record: Record<string, unknown>,
	key: string,
): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}
