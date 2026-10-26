import { afterEach, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: vi.fn(),
}));

import { executeGitHubTool } from "../../src/github";

// Synthetic REST response with nested metadata that should not reach the model.
const account = {
	login: "example-user",
	id: 1,
	avatar_url: "https://example.com/avatar",
};
const repository = {
	id: 2,
	name: "example",
	full_name: "example-org/example",
	owner: account,
	description: "Repository metadata. ".repeat(350),
};
const pr = {
	id: 3,
	node_id: "example-node",
	issue_url: "https://example.com/api/issues/7",
	commits_url: "https://example.com/api/pulls/7/commits",
	review_comments_url: "https://example.com/api/pulls/7/comments",
	review_comment_url: "https://example.com/api/pulls/comments/{number}",
	comments_url: "https://example.com/api/issues/7/comments",
	assignee: account,
	merged_by: null,
	url: "https://example.com/api/pulls/7",
	number: 7,
	title: "Improve search",
	state: "open",
	draft: false,
	merged: false,
	merged_at: null,
	mergeable: null,
	mergeable_state: "unknown",
	user: account,
	head: {
		ref: "fix/search",
		label: "example-org:fix/search",
		sha: "a".repeat(40),
		repo: repository,
		user: account,
	},
	base: {
		ref: "staging",
		sha: "b".repeat(40),
		repo: repository,
		user: account,
	},
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-02T00:00:00Z",
	closed_at: null,
	html_url: "https://example.com/pulls/7",
	body: "Improve search results.",
	labels: [{ id: 4, name: "bug", color: "ffffff" }],
	requested_reviewers: [account],
	requested_teams: [{ id: 5, name: "example-team" }],
	assignees: [account],
	milestone: { id: 6, title: "Next release", description: "Extra metadata" },
	commits: 2,
	additions: 8,
	deletions: 3,
	changed_files: 2,
	comments: 1,
	review_comments: 4,
	_links: { self: { href: "https://example.com/api/pulls/7" } },
	diff_url: "https://example.com/pulls/7.diff",
	patch_url: "https://example.com/pulls/7.patch",
	statuses_url: "https://example.com/statuses",
	merge_commit_sha: null,
	maintainer_can_modify: true,
	rebaseable: null,
	auto_merge: null,
	locked: false,
	active_lock_reason: null,
	author_association: "CONTRIBUTOR",
};

async function read(method: string, response: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(new Response(JSON.stringify(response))),
	);
	return executeGitHubTool(
		method,
		{
			owner: "example-org",
			repo: "example",
			pull_number: 7,
			issue_number: 7,
		},
		"example-user",
		"example-org",
		"example-token",
	);
}

afterEach(() => vi.unstubAllGlobals());

it("projects PR details without nested repository and account metadata", async () => {
	expect(await read("get_pull_request", pr)).toEqual({
		number: 7,
		title: "Improve search",
		state: "open",
		draft: false,
		merged: false,
		merged_at: null,
		mergeable: null,
		mergeable_state: "unknown",
		author: "example-user",
		head: {
			ref: "fix/search",
			sha: "a".repeat(40),
			label: "example-org:fix/search",
			repo: "example-org/example",
		},
		base: { ref: "staging", repo: "example-org/example" },
		created_at: pr.created_at,
		updated_at: pr.updated_at,
		closed_at: null,
		html_url: pr.html_url,
		body: pr.body,
		labels: ["bug"],
		requested_reviewers: ["example-user"],
		requested_teams: [{ slug: null, name: "example-team" }],
		merged_by: null,
		merge_commit_sha: null,
		auto_merge: { enabled: false, merge_method: null },
		assignees: ["example-user"],
		milestone: "Next release",
		commits: 2,
		additions: 8,
		deletions: 3,
		changed_files: 2,
		comments: 1,
		review_comments: 4,
	});
});

it("keeps typical PR details well below the summarization threshold", async () => {
	expect(JSON.stringify(pr).length).toBeGreaterThan(12_000);
	expect(
		JSON.stringify(await read("get_pull_request", pr)).length,
	).toBeLessThan(3_000);
});

it.each(["get_pull_request", "get_issue"])(
	"%s marks a long body as truncated",
	async (method) => {
		const result = (await read(method, {
			...pr,
			body: "x".repeat(30_000),
		})) as { body: string };
		expect(result.body).toBe(
			`${"x".repeat(6_000)}\n\n[Body truncated: showing 6000 of 30000 characters.]`,
		);
		expect(JSON.stringify(result).length).toBeLessThan(9_000);
	},
);

it("projects issue details and preserves state reason", async () => {
	expect(
		await read("get_issue", { ...pr, state_reason: "completed" }),
	).toEqual({
		number: 7,
		title: pr.title,
		state: "open",
		state_reason: "completed",
		is_pull_request: false,
		author: "example-user",
		body: pr.body,
		html_url: pr.html_url,
		created_at: pr.created_at,
		updated_at: pr.updated_at,
		closed_at: null,
		labels: ["bug"],
		assignees: ["example-user"],
		milestone: "Next release",
		comments: 1,
	});
});

it.each(["get_pull_request", "get_issue"])(
	"%s handles absent optional metadata",
	async (method) => {
		const result = await read(method, {
			...pr,
			body: null,
			user: null,
			labels: [],
			assignees: [],
			requested_reviewers: [],
			milestone: null,
		});
		expect(result).toMatchObject({
			body: null,
			author: null,
			labels: [],
			assignees: [],
			milestone: null,
		});
	},
);

it("keeps fork repository identity and head label without repository metadata", async () => {
	const result = await read("get_pull_request", {
		...pr,
		head: {
			...pr.head,
			label: "example-contributor:fix/search",
			repo: { ...repository, full_name: "example-contributor/example" },
		},
	});
	expect(result).toMatchObject({
		head: {
			repo: "example-contributor/example",
			label: "example-contributor:fix/search",
		},
		base: { repo: "example-org/example" },
	});
});

it("represents a deleted fork with a null head repository", async () => {
	expect(
		await read("get_pull_request", {
			...pr,
			head: { ...pr.head, repo: null },
		}),
	).toMatchObject({
		head: {
			repo: null,
			label: "example-org:fix/search",
			sha: "a".repeat(40),
		},
		base: { repo: "example-org/example" },
	});
});

it("keeps a pending team-only review request", async () => {
	expect(
		await read("get_pull_request", {
			...pr,
			requested_reviewers: [],
			requested_teams: [
				{ slug: "example-reviewers", name: "Example reviewers", id: 5 },
			],
		}),
	).toMatchObject({
		requested_reviewers: [],
		requested_teams: [
			{ slug: "example-reviewers", name: "Example reviewers" },
		],
	});
});

it("keeps merger login, merge commit and enabled auto-merge method", async () => {
	expect(
		await read("get_pull_request", {
			...pr,
			merged_by: account,
			merge_commit_sha: "c".repeat(40),
			auto_merge: {
				enabled_by: account,
				merge_method: "squash",
				commit_title: "Extra metadata",
			},
		}),
	).toMatchObject({
		merged_by: "example-user",
		merge_commit_sha: "c".repeat(40),
		auto_merge: { enabled: true, merge_method: "squash" },
	});
});

it("reports disabled auto-merge and absent merger metadata", async () => {
	expect(await read("get_pull_request", pr)).toMatchObject({
		merged_by: null,
		merge_commit_sha: null,
		auto_merge: { enabled: false, merge_method: null },
	});
});

it.each([false, true])(
	"identifies an issue endpoint item as a PR: %s",
	async (isPr) => {
		const result = await read("get_issue", {
			...pr,
			...(isPr
				? { pull_request: { url: "https://example.com/api/pulls/7" } }
				: {}),
		});
		expect(result).toMatchObject({ is_pull_request: isPr });
	},
);

it.each(["get_pull_request", "get_issue"])(
	"%s preserves Unicode at the body truncation boundary",
	async (method) => {
		const result = (await read(method, {
			...pr,
			body: `${"x".repeat(5_999)}😀tail`,
		})) as { body: string };
		expect(result.body).toBe(
			`${"x".repeat(5_999)}\n\n[Body truncated: showing 5999 of 6005 characters.]`,
		);
	},
);
