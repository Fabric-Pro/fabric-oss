import { afterEach, describe, expect, it, vi } from "vitest";
import {
	azureDevOps,
	github,
	gitlab,
	type Target,
} from "../../src/instruction-pull-requests";
import { json, stubFetch, TOKEN } from "./hand-built";

// Hand-built responses to the documented shapes (recorded fixtures owed, R19).

const HEAD = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);

function githubTarget(signal = new AbortController().signal): Target {
	return {
		auth: { token: TOKEN, authMethod: "OAUTH" },
		repository: {
			provider: "GITHUB",
			owner: "example-org",
			repo: "example-repo",
		},
		signal,
	};
}

const MERGE_URL =
	"https://api.github.com/repos/example-org/example-repo/pulls/7/merge";

const mergeInput = (t: Target = githubTarget()) => ({
	...t,
	externalId: "7",
	expectedHeadSha: HEAD,
	method: "squash" as const,
	commitTitle: "Move AI instructions out of the code repository",
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GitHub merge", () => {
	it("merges with the expected head SHA and the merge method, and reports the merge commit", async () => {
		const calls = stubFetch(() =>
			json({ sha: MERGE_SHA, merged: true, message: "merged" }),
		);
		await expect(github.merge(mergeInput())).resolves.toEqual({
			kind: "MERGED",
			mergeCommitSha: MERGE_SHA,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.url).toBe(MERGE_URL);
		expect(calls[0]?.redirect).toBe("manual");
		expect(calls[0]?.body).toEqual({
			sha: HEAD,
			merge_method: "squash",
			commit_title: "Move AI instructions out of the code repository",
		});
		expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	it("405 is not mergeable", async () => {
		stubFetch(() =>
			json({ message: "Required status check is expected" }, 405),
		);
		await expect(github.merge(mergeInput())).resolves.toEqual({
			kind: "REFUSED",
			reason: "not_mergeable",
		});
	});

	it("409 is a head that moved", async () => {
		stubFetch(() =>
			json(
				{
					message:
						"Head branch was modified. Review and try the merge again.",
				},
				409,
			),
		);
		await expect(github.merge(mergeInput())).resolves.toEqual({
			kind: "REFUSED",
			reason: "head_moved",
		});
	});

	it("403 is a permission refusal that keeps the accepted permissions header", async () => {
		stubFetch(() =>
			json({ message: "Resource not accessible by integration" }, 403, {
				"x-accepted-github-permissions":
					"contents=write; pull_requests=write",
			}),
		);
		await expect(github.merge(mergeInput())).resolves.toEqual({
			kind: "REFUSED",
			reason: "permission",
			acceptedPermissions: "contents=write; pull_requests=write",
		});
	});

	it("403 without the header is still a permission refusal", async () => {
		stubFetch(() => json({ message: "Forbidden" }, 403));
		await expect(github.merge(mergeInput())).resolves.toEqual({
			kind: "REFUSED",
			reason: "permission",
		});
	});

	it("a rate-limited 403 is a rate limit, not a permission refusal", async () => {
		stubFetch(() =>
			json({ message: "rate limited" }, 403, {
				"x-ratelimit-remaining": "0",
				"retry-after": "30",
				"x-accepted-github-permissions": "pull_requests=write",
			}),
		);
		await expect(github.merge(mergeInput())).resolves.toEqual({
			kind: "REFUSED",
			reason: "rate_limit",
			retryAfterSeconds: 30,
		});
	});

	it("a network failure is transient, and no refusal carries the token", async () => {
		stubFetch(() => {
			throw new Error(`socket closed for ${TOKEN}`);
		});
		const result = await github.merge(mergeInput());
		expect(result).toEqual({ kind: "REFUSED", reason: "transient" });
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("never builds a URL from a non-numeric id", async () => {
		const calls = stubFetch(() => json({}));
		await expect(
			github.merge({ ...mergeInput(), externalId: "7/../../x" }),
		).resolves.toEqual({ kind: "REFUSED", reason: "not_found" });
		expect(calls).toHaveLength(0);
	});

	it("cancellation propagates as itself", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled");
		stubFetch(() => {
			controller.abort(reason);
			throw new Error("aborted");
		});
		await expect(
			github.merge(mergeInput(githubTarget(controller.signal))),
		).rejects.toBe(reason);
	});
});

describe("GitLab merge", () => {
	const target: Target = {
		auth: { token: TOKEN, authMethod: "OAUTH" },
		repository: {
			provider: "GITLAB",
			projectPath: "example-org/example-repo",
		},
		signal: new AbortController().signal,
	};

	it("merges with sha and squash", async () => {
		const calls = stubFetch(() =>
			json({ iid: 7, state: "merged", merge_commit_sha: MERGE_SHA }),
		);
		await expect(gitlab.merge({ ...mergeInput(target) })).resolves.toEqual({
			kind: "MERGED",
			mergeCommitSha: MERGE_SHA,
		});
		expect(calls[0]?.url).toBe(
			"https://gitlab.com/api/v4/projects/example-org%2Fexample-repo/merge_requests/7/merge",
		);
		expect(calls[0]?.body).toMatchObject({ sha: HEAD, squash: true });
	});

	it("409 is a head that moved; 406 is not mergeable", async () => {
		stubFetch(() => json({ message: "SHA does not match HEAD" }, 409));
		await expect(gitlab.merge(mergeInput(target))).resolves.toEqual({
			kind: "REFUSED",
			reason: "head_moved",
		});
		vi.unstubAllGlobals();
		stubFetch(() => json({ message: "Branch cannot be merged" }, 406));
		await expect(gitlab.merge(mergeInput(target))).resolves.toEqual({
			kind: "REFUSED",
			reason: "not_mergeable",
		});
	});
});

describe("Azure DevOps merge", () => {
	it("is not supported and calls nothing", async () => {
		const calls = stubFetch(() => json({}));
		await expect(
			azureDevOps.merge({
				auth: { token: TOKEN, authMethod: "PAT" },
				repository: {
					provider: "AZURE_DEVOPS",
					apiOrigin: "https://dev.azure.com",
					organization: "example-org",
					project: "example-project",
					repository: "example-repo",
				},
				signal: new AbortController().signal,
				externalId: "7",
				expectedHeadSha: HEAD,
				method: "squash",
			}),
		).resolves.toEqual({ kind: "REFUSED", reason: "unsupported" });
		expect(calls).toHaveLength(0);
	});
});
