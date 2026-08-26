/**
 * "How many new commits since the last analysis" (R8), provider-agnostic.
 * Own implementation (does not touch `@repo/connectors`) hitting each provider's
 * compare/commits REST API. Never throws to the caller — returns
 * `{ comparable: false }` on any failure (e.g. force-push, base sha gone),
 * which the UI renders as "re-analyse recommended".
 */
import { logger } from "@repo/logs";

export interface CountCommitsInput {
	provider: string; // "GITHUB" | "GITLAB" | "AZURE_DEVOPS"
	token: string;
	repositoryUrl: string;
	owner: string;
	repo: string;
	branch: string;
	baseSha: string;
}

export interface CountCommitsResult {
	headSha: string | null;
	aheadBy: number | null;
	/**
	 * Commits in the analysed snapshot that are no longer reachable from the
	 * branch tip (history rewritten). GitHub reports it natively; GitLab needs
	 * a reverse compare; Azure DevOps has no cheap equivalent — `null` there
	 * (and whenever the lookup fails) means "unknown", never "zero".
	 */
	behindBy: number | null;
	comparable: boolean;
}

const INCOMPARABLE: CountCommitsResult = {
	headSha: null,
	aheadBy: null,
	behindBy: null,
	comparable: false,
};

export async function countCommitsSince(
	input: CountCommitsInput,
): Promise<CountCommitsResult> {
	try {
		switch (input.provider) {
			case "GITHUB":
				return await githubCount(input);
			case "GITLAB":
				return await gitlabCount(input);
			case "AZURE_DEVOPS":
				return await adoCount(input);
			default:
				return INCOMPARABLE;
		}
	} catch (error) {
		logger.warn("[atlas] countCommitsSince failed", {
			provider: input.provider,
			error: error instanceof Error ? error.message : String(error),
		});
		return INCOMPARABLE;
	}
}

// ── GitHub ──────────────────────────────────────────────────────────────────
async function githubCount(
	input: CountCommitsInput,
): Promise<CountCommitsResult> {
	const headers = {
		Authorization: `Bearer ${input.token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const base = `https://api.github.com/repos/${input.owner}/${input.repo}`;
	const headRes = await fetch(
		`${base}/commits/${encodeURIComponent(input.branch)}`,
		{ headers },
	);
	if (!headRes.ok) {
		return INCOMPARABLE;
	}
	const head = (await headRes.json()) as { sha?: string };
	const headSha = head.sha ?? null;
	if (!headSha) {
		return INCOMPARABLE;
	}
	if (headSha === input.baseSha) {
		return { headSha, aheadBy: 0, behindBy: 0, comparable: true };
	}

	const cmpRes = await fetch(
		`${base}/compare/${input.baseSha}...${headSha}`,
		{ headers },
	);
	if (!cmpRes.ok) {
		return { headSha, aheadBy: null, behindBy: null, comparable: false };
	}
	const cmp = (await cmpRes.json()) as {
		ahead_by?: number;
		behind_by?: number;
	};
	return {
		headSha,
		aheadBy: typeof cmp.ahead_by === "number" ? cmp.ahead_by : null,
		behindBy: typeof cmp.behind_by === "number" ? cmp.behind_by : null,
		comparable: typeof cmp.ahead_by === "number",
	};
}

// ── GitLab ──────────────────────────────────────────────────────────────────
function gitlabHost(repositoryUrl: string): string {
	try {
		return new URL(repositoryUrl).origin;
	} catch {
		return "https://gitlab.com";
	}
}

async function gitlabCount(
	input: CountCommitsInput,
): Promise<CountCommitsResult> {
	const host = gitlabHost(input.repositoryUrl);
	const projectPath = encodeURIComponent(`${input.owner}/${input.repo}`);
	const headers = { Authorization: `Bearer ${input.token}` };
	// compare returns the `to` commit + the list of commits between from..to.
	const url = `${host}/api/v4/projects/${projectPath}/repository/compare?from=${encodeURIComponent(
		input.baseSha,
	)}&to=${encodeURIComponent(input.branch)}`;
	const res = await fetch(url, { headers });
	if (!res.ok) {
		return INCOMPARABLE;
	}
	const data = (await res.json()) as {
		commit?: { id?: string };
		commits?: Array<unknown>;
	};
	const headSha = data.commit?.id ?? null;
	const aheadBy = Array.isArray(data.commits) ? data.commits.length : null;
	return {
		headSha,
		aheadBy,
		behindBy: await gitlabBehindCount(input, headers),
		comparable: headSha !== null && aheadBy !== null,
	};
}

/**
 * GitLab's compare API is one-directional, so the "behind" side (commits in
 * the analysed snapshot no longer on the branch) needs a reverse compare.
 * Best-effort: any failure resolves `null` (unknown) without affecting the
 * primary ahead count.
 */
async function gitlabBehindCount(
	input: CountCommitsInput,
	headers: Record<string, string>,
): Promise<number | null> {
	try {
		const host = gitlabHost(input.repositoryUrl);
		const projectPath = encodeURIComponent(`${input.owner}/${input.repo}`);
		const url = `${host}/api/v4/projects/${projectPath}/repository/compare?from=${encodeURIComponent(
			input.branch,
		)}&to=${encodeURIComponent(input.baseSha)}`;
		const res = await fetch(url, { headers });
		if (!res.ok) {
			return null;
		}
		const data = (await res.json()) as { commits?: Array<unknown> };
		return Array.isArray(data.commits) ? data.commits.length : null;
	} catch {
		return null;
	}
}

// ── Azure DevOps ─────────────────────────────────────────────────────────────
function parseAdo(repositoryUrl: string): {
	organization: string;
	project: string;
	host: string;
} | null {
	// https://dev.azure.com/{org}/{project}/_git/{repo}
	const devAzure =
		/https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/[^/]+/i.exec(
			repositoryUrl,
		);
	if (devAzure) {
		return {
			organization: devAzure[1],
			project: decodeURIComponent(devAzure[2]),
			host: "https://dev.azure.com",
		};
	}
	// https://{org}.visualstudio.com/{project}/_git/{repo}
	const legacy =
		/https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/[^/]+/i.exec(
			repositoryUrl,
		);
	if (legacy) {
		return {
			organization: legacy[1],
			project: decodeURIComponent(legacy[2]),
			host: `https://${legacy[1]}.visualstudio.com`,
		};
	}
	return null;
}

async function adoCount(input: CountCommitsInput): Promise<CountCommitsResult> {
	const parsed = parseAdo(input.repositoryUrl);
	if (!parsed) {
		return INCOMPARABLE;
	}
	const auth = `Basic ${Buffer.from(`:${input.token}`).toString("base64")}`;
	const apiBase = `${parsed.host}/${parsed.organization}/${encodeURIComponent(
		parsed.project,
	)}/_apis/git/repositories/${encodeURIComponent(input.repo)}`;

	// Commits on `branch` that are not reachable from `baseSha`.
	const params = new URLSearchParams({
		"searchCriteria.itemVersion.versionType": "branch",
		"searchCriteria.itemVersion.version": input.branch,
		"searchCriteria.compareVersion.versionType": "commit",
		"searchCriteria.compareVersion.version": input.baseSha,
		"searchCriteria.$top": "1000",
		"api-version": "7.1",
	});
	const res = await fetch(`${apiBase}/commits?${params.toString()}`, {
		headers: { Authorization: auth, Accept: "application/json" },
	});
	if (!res.ok) {
		return INCOMPARABLE;
	}
	const data = (await res.json()) as {
		count?: number;
		value?: Array<{ commitId?: string }>;
	};
	const aheadBy =
		typeof data.count === "number"
			? data.count
			: Array.isArray(data.value)
				? data.value.length
				: null;
	const headSha = data.value?.[0]?.commitId ?? null;
	// ADO's commits search has no cheap reverse comparison — behind is unknown.
	return { headSha, aheadBy, behindBy: null, comparable: aheadBy !== null };
}
