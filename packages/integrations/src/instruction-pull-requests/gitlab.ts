/**
 * GitLab merge requests for proposals (Fizzy #2563 spec §10). A project's
 * merge-request list includes requests from forks on the same branch name
 * (Review Focus 2), so a candidate must come from the project itself:
 * `source_project_id` equal to `project_id`.
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

const GITLAB_API_ORIGIN = "https://gitlab.com";
const API_PREFIX = `${GITLAB_API_ORIGIN}/api/v4`;

function projectPathOf(t: Target): string {
	if (t.repository.provider !== "GITLAB") {
		throw new Error("The GitLab adapter needs a GitLab repository");
	}
	return t.repository.projectPath;
}

function headers(t: Target): Record<string, string> {
	return {
		Authorization: `Bearer ${t.auth.token}`,
		Accept: "application/json",
	};
}

/** `group/subgroup/project` as one encoded id, whatever form it was stored in. */
function projectUrl(t: Target): string {
	const path = projectPathOf(t)
		.split("/")
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join("/");
	return `${API_PREFIX}/projects/${encodeURIComponent(path)}`;
}

type MergeRequest = {
	iid: number;
	projectId: number | undefined;
	sourceProjectId: number | undefined;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	sourceRef: string;
	targetRef: string;
	sha: string | undefined;
	mergedAt?: string;
	closedAt?: string;
	mergeCommitSha?: string;
};

function parseMergeRequest(v: unknown): MergeRequest | null {
	if (!isRecord(v)) {
		return null;
	}
	const iid = num(v.iid);
	const sourceRef = str(v.source_branch);
	const targetRef = str(v.target_branch);
	const state = str(v.state);
	if (iid === undefined || !sourceRef || !targetRef || !state) {
		return null;
	}
	// `locked` is an open merge request mid-merge.
	const mapped =
		state === "merged"
			? "MERGED"
			: state === "closed"
				? "CLOSED"
				: state === "opened" || state === "locked"
					? "OPEN"
					: null;
	if (!mapped) {
		return null;
	}
	const mergeCommit = str(v.merge_commit_sha) ?? str(v.squash_commit_sha);
	return {
		iid,
		projectId: num(v.project_id),
		sourceProjectId: num(v.source_project_id),
		url: str(v.web_url) ?? "",
		state: mapped,
		sourceRef,
		targetRef,
		sha: str(v.sha),
		...(str(v.merged_at) ? { mergedAt: str(v.merged_at) } : {}),
		...(str(v.closed_at) ? { closedAt: str(v.closed_at) } : {}),
		...(mapped === "MERGED" && mergeCommit
			? { mergeCommitSha: mergeCommit }
			: {}),
	};
}

const fromProjectItself = (mr: MergeRequest): boolean =>
	mr.projectId !== undefined && mr.sourceProjectId === mr.projectId;

function observe(
	t: Target,
	mr: MergeRequest,
	operation: "lookup" | "open" | "close",
): PullRequestObservation {
	if (!mr.sha || !mr.url || !fromProjectItself(mr)) {
		throw adapterError(operation, "unknown");
	}
	return {
		externalId: String(mr.iid),
		url: mr.url,
		state: mr.state,
		sourceRef: mr.sourceRef,
		targetRef: mr.targetRef,
		sourceRepository: { provider: "GITLAB", projectPath: projectPathOf(t) },
		headSha: mr.sha,
		...(mr.mergedAt ? { mergedAt: mr.mergedAt } : {}),
		...(mr.closedAt ? { closedAt: mr.closedAt } : {}),
		...(mr.mergeCommitSha ? { mergeCommitSha: mr.mergeCommitSha } : {}),
	};
}

async function getMergeRequest(
	t: Target,
	iid: string,
	operation: "lookup" | "close",
): Promise<MergeRequest> {
	const res = await requestJson({
		target: t,
		operation,
		method: "GET",
		url: `${projectUrl(t)}/merge_requests/${encodeSegment(iid)}`,
		origin: GITLAB_API_ORIGIN,
		headers: headers(t),
		timeoutMs: LOOKUP_TIMEOUT_MS,
	});
	const mr = parseMergeRequest(res.body);
	if (!mr) {
		throw adapterError(operation, "unknown");
	}
	return mr;
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

const PER_PAGE = 100;

/**
 * GitLab's offset pagination. Its end condition is an empty `X-Next-Page`;
 * a non-empty one must name the page after this one. When the header is
 * missing altogether, only a short page ends the search.
 */
function continuationOf(
	header: string | null,
	page: string,
	items: number,
): Continuation {
	if (header === null) {
		return items < PER_PAGE ? { kind: "end" } : { kind: "inconclusive" };
	}
	const value = header.trim();
	if (value === "") {
		return { kind: "end" };
	}
	return /^[1-9][0-9]*$/.test(value) && Number(value) === Number(page) + 1
		? { kind: "next", next: value }
		: { kind: "inconclusive" };
}

export const gitlab: InstructionPullRequestAdapter = {
	async findOperation(t) {
		const candidates: PullRequestObservation[] = [];
		let page: string | null = "1";
		try {
			for (let n = 0; page; n++) {
				if (n === MAX_PAGES) {
					return { kind: "INCONCLUSIVE", cause: "unknown" };
				}
				const res = await requestJson({
					target: t,
					operation: "lookup",
					method: "GET",
					url: `${projectUrl(t)}/merge_requests?source_branch=${encodeURIComponent(t.sourceRef)}&state=all&per_page=${PER_PAGE}&page=${encodeURIComponent(page)}`,
					origin: GITLAB_API_ORIGIN,
					headers: headers(t),
					timeoutMs: LOOKUP_TIMEOUT_MS,
				});
				if (!Array.isArray(res.body)) {
					return { kind: "INCONCLUSIVE", cause: "unknown" };
				}
				for (const item of res.body) {
					let mr = parseMergeRequest(item);
					if (!mr) {
						return { kind: "INCONCLUSIVE", cause: "unknown" };
					}
					if (mr.sourceProjectId === undefined || !mr.sha) {
						mr = await getMergeRequest(t, String(mr.iid), "lookup");
					}
					if (fromProjectItself(mr) && mr.sourceRef === t.sourceRef) {
						candidates.push(observe(t, mr, "lookup"));
					}
				}
				const continuation = continuationOf(
					res.headers.get("x-next-page"),
					page,
					res.body.length,
				);
				if (continuation.kind === "inconclusive") {
					return { kind: "INCONCLUSIVE", cause: "unknown" };
				}
				page = continuation.kind === "next" ? continuation.next : null;
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
			url: `${projectUrl(t)}/merge_requests`,
			origin: GITLAB_API_ORIGIN,
			headers: headers(t),
			body: {
				source_branch: t.sourceRef,
				target_branch: t.targetRef,
				title: t.title,
				description: t.body,
				remove_source_branch: false,
			},
			timeoutMs: OPEN_TIMEOUT_MS,
			// GitLab refuses a second open merge request for one source branch with 409.
			isDuplicate: (status) => status === 409,
		});
		const mr = parseMergeRequest(res.body);
		if (!mr) {
			throw adapterError("open", "unknown");
		}
		return observe(t, mr, "open");
	},

	async get(t) {
		return observe(
			t,
			await getMergeRequest(t, t.externalId, "lookup"),
			"lookup",
		);
	},

	async close(t) {
		const res = await requestJson({
			target: t,
			operation: "close",
			method: "PUT",
			url: `${projectUrl(t)}/merge_requests/${encodeSegment(t.externalId)}`,
			origin: GITLAB_API_ORIGIN,
			headers: headers(t),
			body: { state_event: "close" },
			timeoutMs: LOOKUP_TIMEOUT_MS,
		});
		const mr = parseMergeRequest(res.body);
		if (!mr) {
			throw adapterError("close", "unknown");
		}
		return observe(t, mr, "close");
	},
};
