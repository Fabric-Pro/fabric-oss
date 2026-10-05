import {
	gitlabHeaders,
	gitlabHost,
	parseAdoRepositoryUrl,
	type VerifyRepositoryBranchInput,
} from "./repository-branch";

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
	/** The provider's web page for one commit. */
	commitUrl(sha: string): string;
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
				base: `https://api.github.com/repos/${repository}`,
				headers: {
					Authorization: `Bearer ${input.token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				commitUrl: (sha) =>
					`https://github.com/${repository}/commit/${sha}`,
			};
		}
		case "GITLAB": {
			const host = gitlabHost();
			const path = `${input.owner}/${input.repo}`;
			return {
				provider: "GITLAB",
				base: `${host}/api/v4/projects/${encodeURIComponent(path)}`,
				headers: gitlabHeaders(input),
				commitUrl: (sha) =>
					`${host}/${path.split("/").map(encodeURIComponent).join("/")}/-/commit/${sha}`,
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
				base: `${root}/_apis/git/repositories/${encodeURIComponent(repoName)}`,
				headers: {
					Authorization: `Basic ${Buffer.from(`:${input.token}`).toString("base64")}`,
					Accept: "application/json",
				},
				commitUrl: (sha) =>
					`${root}/_git/${encodeURIComponent(repoName)}/commit/${sha}`,
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

/**
 * One GET on the repository's API, parsed as JSON. Never throws: a network
 * failure, a timeout, an oversize or non-JSON body is `unreachable`; Azure
 * DevOps's 203 sign-in page for a rejected token is `unauthorized`.
 */
export async function getRepositoryJson(
	target: RepositoryApiTarget,
	pathAndQuery: string,
): Promise<RepositoryJson> {
	let response: Response;
	try {
		response = await fetch(`${target.base}${pathAndQuery}`, {
			headers: target.headers,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
		const reader = response.body?.getReader();
		if (!reader) {
			return { ok: true, data: JSON.parse(await response.text()) };
		}
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => {});
				return { ok: false, outcome: "unreachable" };
			}
			chunks.push(value);
		}
		return {
			ok: true,
			data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
		};
	} catch {
		return { ok: false, outcome: "unreachable" };
	}
}

type RepositoryHeadSize =
	| { ok: true; size: number | null }
	| { ok: false; outcome: RepositoryFailure };

/**
 * One HEAD on the repository's API, answering the size the provider reports in
 * `sizeHeader` (null when the header is absent or is not a whole number). The
 * body of a HEAD is never read, so a caller can refuse a file that is too large
 * before a GET buffers it. Never throws: a network failure or a timeout is
 * `unreachable`; Azure DevOps's 203 sign-in page for a rejected token is
 * `unauthorized`.
 */
export async function headRepositorySize(
	target: RepositoryApiTarget,
	pathAndQuery: string,
	sizeHeader: string,
): Promise<RepositoryHeadSize> {
	let response: Response;
	try {
		response = await fetch(`${target.base}${pathAndQuery}`, {
			method: "HEAD",
			headers: target.headers,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
	const reported = response.headers.get(sizeHeader);
	const size =
		reported !== null && /^\d+$/.test(reported) ? Number(reported) : null;
	return { ok: true, size };
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
