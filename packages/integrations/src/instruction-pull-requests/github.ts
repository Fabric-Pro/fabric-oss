/**
 * GitHub pull requests for proposals (Fizzy #2563 spec §10): `head` filtering
 * by `owner:branch` excludes forks already, and the source repository is
 * checked again on every candidate.
 */
import {
	adapterError,
	type Continuation,
	LOOKUP_TIMEOUT_MS,
	MAX_PAGES,
	OPEN_TIMEOUT_MS,
} from "./classify";
import { encodeSegment, isRecord, num, requestJson, str } from "./http";
import {
	type FindOperationResult,
	type InstructionPullRequestAdapter,
	InstructionPullRequestError,
	type PullRequestObservation,
	type Target,
} from "./types";

const GITHUB_API_ORIGIN = "https://api.github.com";

function repoOf(t: Target): { owner: string; repo: string } {
	if (t.repository.provider !== "GITHUB") {
		throw new Error("The GitHub adapter needs a GitHub repository");
	}
	return { owner: t.repository.owner, repo: t.repository.repo };
}

function headers(t: Target): Record<string, string> {
	return {
		Authorization: `Bearer ${t.auth.token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "fabric-instructions",
	};
}

function pullsUrl(t: Target): string {
	const { owner, repo } = repoOf(t);
	return `${GITHUB_API_ORIGIN}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/pulls`;
}

/**
 * GitHub's `Link` header (RFC 8288). GitHub's end condition is a response
 * with no `rel="next"` link. Every part must parse as `<url>; params`; one
 * `rel="next"` link, on GitHub's own origin and the same pulls path, is
 * followed; anything else about a next link (unparsable, elsewhere, twice)
 * leaves the search inconclusive.
 */
function continuationOf(link: string | null, listPath: string): Continuation {
	if (link === null || link.trim() === "") {
		return { kind: "end" };
	}
	let next: string | null = null;
	for (const part of link.split(",")) {
		const match = /^\s*<([^>]*)>\s*((?:;\s*[^;]*)*)$/.exec(part);
		if (!match) {
			return { kind: "inconclusive" };
		}
		const rel = /;\s*rel\s*=\s*"?([^";]*)"?/i.exec(match[2] ?? "")?.[1];
		if (!rel?.trim().split(/\s+/).includes("next")) {
			continue;
		}
		if (next !== null) {
			return { kind: "inconclusive" };
		}
		let url: URL;
		try {
			url = new URL(match[1] ?? "");
		} catch {
			return { kind: "inconclusive" };
		}
		if (url.origin !== GITHUB_API_ORIGIN || url.pathname !== listPath) {
			return { kind: "inconclusive" };
		}
		next = url.toString();
	}
	return next === null ? { kind: "end" } : { kind: "next", next };
}

type Pull = {
	number: number;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	headRef: string;
	baseRef: string;
	headSha: string | undefined;
	/** `owner/repo` of the head repository; undefined when GitHub did not say (or the fork is gone). */
	headFullName: string | undefined;
	headOwner: string | undefined;
	headRepo: string | undefined;
	mergedAt?: string;
	closedAt?: string;
	mergeCommitSha?: string;
};

function parsePull(v: unknown): Pull | null {
	if (!isRecord(v)) {
		return null;
	}
	const number = num(v.number);
	const head = isRecord(v.head) ? v.head : {};
	const base = isRecord(v.base) ? v.base : {};
	const headRepo = isRecord(head.repo) ? head.repo : null;
	const owner = headRepo && isRecord(headRepo.owner) ? headRepo.owner : null;
	const headRef = str(head.ref);
	const baseRef = str(base.ref);
	if (number === undefined || !headRef || !baseRef) {
		return null;
	}
	const mergedAt = str(v.merged_at);
	const merged = v.merged === true || mergedAt !== undefined;
	const closed = v.state === "closed";
	return {
		number,
		url: str(v.html_url) ?? "",
		state: merged ? "MERGED" : closed ? "CLOSED" : "OPEN",
		headRef,
		baseRef,
		headSha: str(head.sha),
		headFullName: headRepo ? str(headRepo.full_name) : undefined,
		headOwner: owner ? str(owner.login) : undefined,
		headRepo: headRepo ? str(headRepo.name) : undefined,
		...(mergedAt ? { mergedAt } : {}),
		...(str(v.closed_at) ? { closedAt: str(v.closed_at) } : {}),
		...(merged && str(v.merge_commit_sha)
			? { mergeCommitSha: str(v.merge_commit_sha) }
			: {}),
	};
}

function observe(
	p: Pull,
	operation: "lookup" | "open" | "close",
): PullRequestObservation {
	if (!p.headSha || !p.headOwner || !p.headRepo || !p.url) {
		throw adapterError(operation, "unknown");
	}
	return {
		externalId: String(p.number),
		url: p.url,
		state: p.state,
		sourceRef: p.headRef,
		targetRef: p.baseRef,
		sourceRepository: {
			provider: "GITHUB",
			owner: p.headOwner,
			repo: p.headRepo,
		},
		headSha: p.headSha,
		...(p.mergedAt ? { mergedAt: p.mergedAt } : {}),
		...(p.closedAt ? { closedAt: p.closedAt } : {}),
		...(p.mergeCommitSha ? { mergeCommitSha: p.mergeCommitSha } : {}),
	};
}

async function getPull(
	t: Target,
	externalId: string,
	operation: "lookup" | "close",
): Promise<Pull> {
	const res = await requestJson({
		target: t,
		operation,
		method: "GET",
		url: `${pullsUrl(t)}/${encodeSegment(externalId)}`,
		origin: GITHUB_API_ORIGIN,
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

export const github: InstructionPullRequestAdapter = {
	async findOperation(t) {
		const { owner, repo } = repoOf(t);
		const fullName = `${owner}/${repo}`.toLowerCase();
		const candidates: PullRequestObservation[] = [];
		let url: string | null =
			`${pullsUrl(t)}?head=${encodeURIComponent(`${owner}:${t.sourceRef}`)}&state=all&per_page=100`;
		try {
			for (let page = 0; url; page++) {
				if (page === MAX_PAGES) {
					return { kind: "INCONCLUSIVE", cause: "unknown" };
				}
				const res = await requestJson({
					target: t,
					operation: "lookup",
					method: "GET",
					url,
					origin: GITHUB_API_ORIGIN,
					headers: headers(t),
					timeoutMs: LOOKUP_TIMEOUT_MS,
				});
				if (!Array.isArray(res.body)) {
					return { kind: "INCONCLUSIVE", cause: "unknown" };
				}
				for (const item of res.body) {
					let pull = parsePull(item);
					if (!pull) {
						return { kind: "INCONCLUSIVE", cause: "unknown" };
					}
					if (!pull.headFullName || !pull.headSha) {
						pull = await getPull(t, String(pull.number), "lookup");
					}
					if (
						pull.headFullName?.toLowerCase() === fullName &&
						pull.headRef === t.sourceRef
					) {
						candidates.push(observe(pull, "lookup"));
					}
				}
				const continuation = continuationOf(
					res.headers.get("link"),
					new URL(pullsUrl(t)).pathname,
				);
				if (continuation.kind === "inconclusive") {
					return { kind: "INCONCLUSIVE", cause: "unknown" };
				}
				url = continuation.kind === "next" ? continuation.next : null;
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
			url: pullsUrl(t),
			origin: GITHUB_API_ORIGIN,
			headers: headers(t),
			body: {
				title: t.title,
				head: t.sourceRef,
				base: t.targetRef,
				body: t.body,
				maintainer_can_modify: false,
			},
			timeoutMs: OPEN_TIMEOUT_MS,
			isDuplicate: (status, text) =>
				status === 422 && /already exists/i.test(text),
		});
		const pull = parsePull(res.body);
		if (!pull) {
			throw adapterError("open", "unknown");
		}
		return observe(pull, "open");
	},

	async get(t) {
		return observe(await getPull(t, t.externalId, "lookup"), "lookup");
	},

	async close(t) {
		const res = await requestJson({
			target: t,
			operation: "close",
			method: "PATCH",
			url: `${pullsUrl(t)}/${encodeSegment(t.externalId)}`,
			origin: GITHUB_API_ORIGIN,
			headers: headers(t),
			body: { state: "closed" },
			timeoutMs: LOOKUP_TIMEOUT_MS,
		});
		const pull = parsePull(res.body);
		if (!pull) {
			throw adapterError("close", "unknown");
		}
		return observe(pull, "close");
	},
};
