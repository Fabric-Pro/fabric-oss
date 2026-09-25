/**
 * HAND-BUILT provider responses, shaped after each provider's documented API
 * (GitHub REST pulls, GitLab merge requests v4, Azure DevOps Git pull
 * requests 7.1). They are NOT recordings. Plan Decision 15 and R19 require
 * recorded, sanitized responses; those are outstanding validation owed
 * before the staging smoke, and belong under `fixtures/<provider>/` when
 * captured. Every identifier here is synthetic, and every commit SHA and
 * token is assembled at runtime.
 */
import { createHash } from "node:crypto";
import { vi } from "vitest";

/** A 40-hex commit id derived from a label, so no SHA literal is written down. */
export const commit = (label: string): string =>
	createHash("sha1").update(label).digest("hex");

export const BRANCH = "fabric/instructions/cexample000000000000000a";
export const TOKEN = `gh${"p_"}${"B".repeat(36)}`;
export const PAT = `pat-${"C".repeat(40)}`;

export type Call = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
	signal: AbortSignal | undefined;
	redirect: string | undefined;
};

/** Stubs `fetch`, recording every request; the handler answers each call. */
export function stubFetch(
	handler: (call: Call, index: number) => Response | Promise<Response>,
): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			const call: Call = {
				url: String(url),
				method: init.method ?? "GET",
				headers: { ...(init.headers as Record<string, string>) },
				body:
					typeof init.body === "string"
						? JSON.parse(init.body)
						: undefined,
				signal: init.signal ?? undefined,
				redirect: init.redirect,
			};
			calls.push(call);
			return handler(call, calls.length - 1);
		}),
	);
	return calls;
}

export function json(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

// --- GitHub -----------------------------------------------------------------

export function githubPull(o: {
	number: number;
	ref?: string;
	base?: string;
	headFullName?: string | null;
	sha?: string | null;
	state?: "open" | "closed";
	merged?: boolean;
}): Record<string, unknown> {
	const fullName =
		o.headFullName === undefined
			? "example-org/example-repo"
			: o.headFullName;
	const [owner, name] = (fullName ?? "/").split("/");
	return {
		number: o.number,
		html_url: `https://github.com/example-org/example-repo/pull/${o.number}`,
		state: o.state ?? "open",
		merged: o.merged ?? false,
		merged_at: o.merged ? "2026-09-24T01:00:00Z" : null,
		closed_at: o.state === "closed" ? "2026-09-24T01:00:00Z" : null,
		merge_commit_sha: o.merged ? commit(`merge-${o.number}`) : null,
		user: { login: "example-bot" },
		head: {
			ref: o.ref ?? BRANCH,
			sha:
				o.sha === null
					? undefined
					: (o.sha ?? commit(`head-${o.number}`)),
			...(fullName === null
				? {}
				: {
						repo: {
							full_name: fullName,
							name,
							owner: { login: owner },
						},
					}),
		},
		base: { ref: o.base ?? "main" },
	};
}

// --- GitLab -----------------------------------------------------------------

const GITLAB_PROJECT_ID = 42;

export function gitlabMergeRequest(o: {
	iid: number;
	ref?: string;
	target?: string;
	sourceProjectId?: number | null;
	sha?: string | null;
	state?: "opened" | "locked" | "merged" | "closed";
}): Record<string, unknown> {
	return {
		iid: o.iid,
		project_id: GITLAB_PROJECT_ID,
		...(o.sourceProjectId === null
			? {}
			: { source_project_id: o.sourceProjectId ?? GITLAB_PROJECT_ID }),
		web_url: `https://gitlab.com/example-org/sub/example-repo/-/merge_requests/${o.iid}`,
		state: o.state ?? "opened",
		source_branch: o.ref ?? BRANCH,
		target_branch: o.target ?? "main",
		...(o.sha === null ? {} : { sha: o.sha ?? commit(`mr-${o.iid}`) }),
		merged_at: o.state === "merged" ? "2026-09-24T01:00:00Z" : null,
		closed_at: o.state === "closed" ? "2026-09-24T01:00:00Z" : null,
		merge_commit_sha:
			o.state === "merged" ? commit(`merge-${o.iid}`) : null,
	};
}

// --- Azure DevOps -------------------------------------------------------------

export function adoPull(o: {
	id: number;
	ref?: string;
	target?: string;
	fork?: boolean;
	sha?: string | null;
	status?: "active" | "completed" | "abandoned";
}): Record<string, unknown> {
	return {
		pullRequestId: o.id,
		status: o.status ?? "active",
		sourceRefName: `refs/heads/${o.ref ?? BRANCH}`,
		targetRefName: `refs/heads/${o.target ?? "main"}`,
		...(o.sha === null
			? {}
			: {
					lastMergeSourceCommit: {
						commitId: o.sha ?? commit(`ado-${o.id}`),
					},
				}),
		...(o.status === "completed"
			? { lastMergeCommit: { commitId: commit(`ado-merge-${o.id}`) } }
			: {}),
		...(o.status && o.status !== "active"
			? { closedDate: "2026-09-24T01:00:00Z" }
			: {}),
		repository: {
			id: "repo-guid-1",
			name: "example-repo",
			webUrl: "https://dev.azure.com/example-org/Example%20Project/_git/example-repo",
		},
		...(o.fork
			? {
					forkSource: {
						name: `refs/heads/${o.ref ?? BRANCH}`,
						repository: { id: "fork-guid-1", name: "example-repo" },
					},
				}
			: {}),
	};
}
