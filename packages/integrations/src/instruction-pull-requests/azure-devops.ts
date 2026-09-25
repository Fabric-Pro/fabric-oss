/**
 * Azure DevOps pull requests for proposals (Fizzy #2563 spec §10), REST
 * `api-version=7.1`. A repository's pull-request list includes requests from
 * forks on the same source ref name (Review Focus 2); a fork's request
 * carries `forkSource` and is never a candidate.
 *
 * The PAT header is a local copy of the connectors' module-private
 * `adoAuthHeader` (`packages/connectors/src/azure-devops/discovery.ts`):
 * `@repo/integrations` does not depend on `@repo/connectors` (plan R5).
 */
import {
	adapterError,
	LOOKUP_TIMEOUT_MS,
	MAX_PAGES,
	OPEN_TIMEOUT_MS,
} from "./classify";
import { azureDevOpsDescription } from "./description";
import { encodeSegment, isRecord, num, requestJson, str } from "./http";
import {
	type FindOperationResult,
	type InstructionPullRequestAdapter,
	InstructionPullRequestError,
	type PullRequestObservation,
	type RepositoryIdentity,
	type Target,
} from "./types";

const API_VERSION = "api-version=7.1";
const PAGE_SIZE = 100;
const HEADS = "refs/heads/";

/** Azure DevOps authenticates a PAT as `base64(":" + pat)` (empty username). */
function adoAuthHeader(pat: string): string {
	return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

type AdoRepository = Extract<RepositoryIdentity, { provider: "AZURE_DEVOPS" }>;

function adoRepositoryOf(repository: RepositoryIdentity): AdoRepository {
	if (repository.provider !== "AZURE_DEVOPS") {
		throw new Error(
			"The Azure DevOps adapter needs an Azure DevOps repository",
		);
	}
	return repository;
}

function checkedOrigin(repository: AdoRepository): URL {
	let origin: URL;
	try {
		origin = new URL(repository.apiOrigin);
	} catch {
		throw new Error("Azure DevOps origin refused");
	}
	if (
		origin.protocol !== "https:" ||
		origin.port !== "" ||
		origin.username !== "" ||
		origin.password !== "" ||
		origin.pathname !== "/" ||
		origin.search !== "" ||
		origin.hash !== "" ||
		origin.origin !== repository.apiOrigin ||
		!(
			origin.hostname === "dev.azure.com" ||
			/^[a-z0-9][a-z0-9-]*\.visualstudio\.com$/.test(origin.hostname)
		)
	) {
		throw new Error("Azure DevOps origin refused");
	}
	return origin;
}

/**
 * The project's API base: `https://dev.azure.com/{organization}/{project}`
 * or `https://<org>.visualstudio.com/{project}`, the only two hosts accepted,
 * without a port, userinfo or path (spec §10). Each segment is encoded
 * exactly once, whether it was stored decoded or percent-encoded, so a
 * project named `Example Project` is `Example%20Project`, never `%2520`
 * (Review Focus 3).
 */
export function adoApiBase(repository: RepositoryIdentity): string {
	const ado = adoRepositoryOf(repository);
	const origin = checkedOrigin(ado);
	return origin.hostname === "dev.azure.com"
		? `${origin.origin}/${encodeSegment(ado.organization)}/${encodeSegment(ado.project)}`
		: `${origin.origin}/${encodeSegment(ado.project)}`;
}

function headers(t: Target): Record<string, string> {
	return {
		Authorization:
			t.auth.authMethod === "PAT"
				? adoAuthHeader(t.auth.token)
				: `Bearer ${t.auth.token}`,
		Accept: "application/json",
	};
}

function pullsUrl(t: Target): string {
	const ado = adoRepositoryOf(t.repository);
	return `${adoApiBase(ado)}/_apis/git/repositories/${encodeSegment(ado.repository)}/pullrequests`;
}

const branchOf = (ref: string | undefined): string | undefined =>
	ref?.startsWith(HEADS) ? ref.slice(HEADS.length) : undefined;

type AdoPull = {
	id: number;
	state: "OPEN" | "MERGED" | "CLOSED";
	sourceRef: string;
	targetRef: string;
	headSha: string | undefined;
	fork: boolean;
	webUrl: string | undefined;
	mergedAt?: string;
	closedAt?: string;
	mergeCommitSha?: string;
};

function commitOf(v: unknown): string | undefined {
	return isRecord(v) ? str(v.commitId) : undefined;
}

function parsePull(v: unknown): AdoPull | null {
	if (!isRecord(v)) {
		return null;
	}
	const id = num(v.pullRequestId);
	const sourceRef = branchOf(str(v.sourceRefName));
	const targetRef = branchOf(str(v.targetRefName));
	const status = str(v.status);
	const state =
		status === "active"
			? "OPEN"
			: status === "completed"
				? "MERGED"
				: status === "abandoned"
					? "CLOSED"
					: null;
	if (id === undefined || !sourceRef || !targetRef || !state) {
		return null;
	}
	const repository = isRecord(v.repository) ? v.repository : {};
	const closedDate = str(v.closedDate);
	const mergeCommit = commitOf(v.lastMergeCommit);
	return {
		id,
		state,
		sourceRef,
		targetRef,
		headSha: commitOf(v.lastMergeSourceCommit),
		fork: v.forkSource !== undefined && v.forkSource !== null,
		webUrl: str(repository.webUrl),
		...(state === "MERGED" && closedDate ? { mergedAt: closedDate } : {}),
		...(state !== "OPEN" && closedDate ? { closedAt: closedDate } : {}),
		...(state === "MERGED" && mergeCommit
			? { mergeCommitSha: mergeCommit }
			: {}),
	};
}

/** The pull request's web page on the repository's own origin. */
function webUrlOf(t: Target, pull: AdoPull): string {
	const ado = adoRepositoryOf(t.repository);
	if (pull.webUrl) {
		try {
			const url = new URL(pull.webUrl);
			if (url.origin === ado.apiOrigin) {
				return `${url.origin}${url.pathname.replace(/\/$/, "")}/pullrequest/${pull.id}`;
			}
		} catch {
			// Fall through to the constructed form.
		}
	}
	return `${adoApiBase(ado)}/_git/${encodeSegment(ado.repository)}/pullrequest/${pull.id}`;
}

function observe(
	t: Target,
	pull: AdoPull,
	operation: "lookup" | "open" | "close",
): PullRequestObservation {
	if (!pull.headSha || pull.fork) {
		throw adapterError(operation, "unknown");
	}
	return {
		externalId: String(pull.id),
		url: webUrlOf(t, pull),
		state: pull.state,
		sourceRef: pull.sourceRef,
		targetRef: pull.targetRef,
		sourceRepository: adoRepositoryOf(t.repository),
		headSha: pull.headSha,
		...(pull.mergedAt ? { mergedAt: pull.mergedAt } : {}),
		...(pull.closedAt ? { closedAt: pull.closedAt } : {}),
		...(pull.mergeCommitSha ? { mergeCommitSha: pull.mergeCommitSha } : {}),
	};
}

async function getPull(
	t: Target,
	externalId: string,
	operation: "lookup" | "close",
): Promise<AdoPull> {
	const res = await requestJson({
		target: t,
		operation,
		method: "GET",
		url: `${pullsUrl(t)}/${encodeSegment(externalId)}?${API_VERSION}`,
		origin: adoRepositoryOf(t.repository).apiOrigin,
		headers: headers(t),
		timeoutMs: LOOKUP_TIMEOUT_MS,
	});
	const pull = parsePull(res.body);
	if (!pull) {
		throw adapterError(operation, "unknown");
	}
	return pull;
}

function inconclusive(error: unknown): FindOperationResult {
	if (error instanceof InstructionPullRequestError) {
		return {
			kind: "INCONCLUSIVE",
			cause: error.cause,
			...(error.retryAfterSeconds === undefined
				? {}
				: { retryAfterSeconds: error.retryAfterSeconds }),
		};
	}
	throw error;
}

export const azureDevOps: InstructionPullRequestAdapter = {
	async findOperation(t) {
		const base = pullsUrl(t);
		const origin = adoRepositoryOf(t.repository).apiOrigin;
		const sourceRefName = `${HEADS}${t.sourceRef}`;
		const candidates: PullRequestObservation[] = [];
		try {
			for (let page = 0; ; page++) {
				if (page === MAX_PAGES) {
					return { kind: "INCONCLUSIVE", cause: "unknown" };
				}
				const res = await requestJson({
					target: t,
					operation: "lookup",
					method: "GET",
					url: `${base}?searchCriteria.sourceRefName=${encodeURIComponent(sourceRefName)}&searchCriteria.status=all&$top=${PAGE_SIZE}&$skip=${page * PAGE_SIZE}&${API_VERSION}`,
					origin,
					headers: headers(t),
					timeoutMs: LOOKUP_TIMEOUT_MS,
				});
				const items =
					isRecord(res.body) && Array.isArray(res.body.value)
						? res.body.value
						: null;
				if (!items) {
					return { kind: "INCONCLUSIVE", cause: "unknown" };
				}
				for (const item of items) {
					let pull = parsePull(item);
					if (!pull) {
						return { kind: "INCONCLUSIVE", cause: "unknown" };
					}
					if (pull.fork) {
						continue;
					}
					if (!pull.headSha) {
						pull = await getPull(t, String(pull.id), "lookup");
					}
					if (!pull.fork && pull.sourceRef === t.sourceRef) {
						candidates.push(observe(t, pull, "lookup"));
					}
				}
				// The list pages with $top/$skip and ends on a short page. A
				// continuation token is a paging scheme this loop does not
				// follow, so the search would be incomplete.
				if (res.headers.get("x-ms-continuationtoken")) {
					return { kind: "INCONCLUSIVE", cause: "unknown" };
				}
				if (items.length < PAGE_SIZE) {
					break;
				}
			}
		} catch (error) {
			return inconclusive(error);
		}
		if (candidates.length === 0) {
			return { kind: "ABSENT" };
		}
		if (candidates.length > 1) {
			return { kind: "INCONCLUSIVE", cause: "conflict" };
		}
		return {
			kind: "FOUND",
			value: candidates[0] as PullRequestObservation,
		};
	},

	async open(t) {
		const res = await requestJson({
			target: t,
			operation: "open",
			method: "POST",
			url: `${pullsUrl(t)}?${API_VERSION}`,
			origin: adoRepositoryOf(t.repository).apiOrigin,
			headers: headers(t),
			body: {
				sourceRefName: `${HEADS}${t.sourceRef}`,
				targetRefName: `${HEADS}${t.targetRef}`,
				title: t.title,
				// 4000 characters at most: the note is shortened, never the footer.
				description: azureDevOpsDescription(t.body),
			},
			timeoutMs: OPEN_TIMEOUT_MS,
			// TF401179: an active pull request for this source and target exists.
			isDuplicate: (status, text) =>
				status === 409 && /TF401179/.test(text),
		});
		const pull = parsePull(res.body);
		if (!pull) {
			throw adapterError("open", "unknown");
		}
		return observe(t, pull, "open");
	},

	async get(t) {
		return observe(t, await getPull(t, t.externalId, "lookup"), "lookup");
	},

	async close(t) {
		const res = await requestJson({
			target: t,
			operation: "close",
			method: "PATCH",
			url: `${pullsUrl(t)}/${encodeSegment(t.externalId)}?${API_VERSION}`,
			origin: adoRepositoryOf(t.repository).apiOrigin,
			headers: headers(t),
			body: { status: "abandoned" },
			timeoutMs: LOOKUP_TIMEOUT_MS,
		});
		const pull = parsePull(res.body);
		if (!pull) {
			throw adapterError("close", "unknown");
		}
		return observe(t, pull, "close");
	},
};
