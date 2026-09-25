import { afterEach, describe, expect, it, vi } from "vitest";
import {
	adapterFor,
	gitlab,
	type Target,
} from "../../src/instruction-pull-requests";
import {
	BRANCH,
	commit,
	gitlabMergeRequest,
	json,
	stubFetch,
	TOKEN,
} from "./hand-built";

// Hand-built responses (see hand-built.ts); recorded fixtures are owed (R19).

function target(projectPath = "example-org/sub/example-repo"): Target {
	return {
		auth: { token: TOKEN, authMethod: "OAUTH" },
		repository: { provider: "GITLAB", projectPath },
		signal: new AbortController().signal,
	};
}

const PROJECT =
	"https://gitlab.com/api/v4/projects/example-org%2Fsub%2Fexample-repo";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GitLab findOperation", () => {
	it("pages with X-Next-Page across targets and states, ignoring a fork's merge request on the same branch name", async () => {
		const calls = stubFetch((_call, index) =>
			index === 0
				? json(
						[gitlabMergeRequest({ iid: 1, sourceProjectId: 99 })],
						200,
						{
							"x-next-page": "2",
						},
					)
				: json(
						[
							gitlabMergeRequest({
								iid: 2,
								target: "release",
								state: "merged",
							}),
						],
						200,
						{ "x-next-page": "" },
					),
		);
		const found = await gitlab.findOperation({
			...target(),
			sourceRef: BRANCH,
		});
		expect(found).toEqual({
			kind: "FOUND",
			value: expect.objectContaining({
				externalId: "2",
				state: "MERGED",
				targetRef: "release",
				headSha: commit("mr-2"),
				mergeCommitSha: commit("merge-2"),
			}),
		});
		expect(calls).toHaveLength(2);
		const first = new URL(calls[0]?.url as string);
		expect(`${first.origin}${first.pathname}`).toBe(
			`${PROJECT}/merge_requests`,
		);
		expect(first.searchParams.get("source_branch")).toBe(BRANCH);
		expect(first.searchParams.get("state")).toBe("all");
		expect(first.searchParams.get("per_page")).toBe("100");
		expect(new URL(calls[1]?.url as string).searchParams.get("page")).toBe(
			"2",
		);
		expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	it("ignores a fork's merge request on the same branch name", async () => {
		stubFetch(() =>
			json([gitlabMergeRequest({ iid: 3, sourceProjectId: 99 })]),
		);
		expect(
			await gitlab.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "ABSENT" });
	});

	it("hydrates through get when a list entry lacks its source project or SHA", async () => {
		const calls = stubFetch((call) =>
			call.url === `${PROJECT}/merge_requests/4`
				? json(gitlabMergeRequest({ iid: 4 }))
				: json([
						gitlabMergeRequest({
							iid: 4,
							sourceProjectId: null,
							sha: null,
						}),
					]),
		);
		expect(
			(await gitlab.findOperation({ ...target(), sourceRef: BRANCH }))
				.kind,
		).toBe("FOUND");
		expect(calls).toHaveLength(2);
	});

	// Only GitLab's own end condition completes a search: an empty
	// X-Next-Page, or, when the header is missing, a short page. A
	// continuation it cannot follow leaves the search incomplete (spec §10).
	it.each(["abc", "2x", "0", "-1", "1.5", "3"])(
		"reports a malformed or out-of-order X-Next-Page %j as INCONCLUSIVE, even after a candidate",
		async (next) => {
			const calls = stubFetch(() =>
				json([gitlabMergeRequest({ iid: 8 })], 200, {
					"x-next-page": next,
				}),
			);
			expect(
				await gitlab.findOperation({ ...target(), sourceRef: BRANCH }),
			).toEqual({ kind: "INCONCLUSIVE", cause: "unknown" });
			expect(calls).toHaveLength(1);
		},
	);

	it("reports a full page without X-Next-Page as INCONCLUSIVE, and ends on a short one", async () => {
		const forks = Array.from({ length: 100 }, (_, n) =>
			gitlabMergeRequest({ iid: 100 + n, sourceProjectId: 99 }),
		);
		let calls = stubFetch(() => json(forks));
		expect(
			await gitlab.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "INCONCLUSIVE", cause: "unknown" });
		expect(calls).toHaveLength(1);
		calls = stubFetch(() => json(forks.slice(0, 99)));
		expect(
			await gitlab.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "ABSENT" });
		expect(calls).toHaveLength(1);
	});

	it("reports INCONCLUSIVE after 10 pages and on several candidates", async () => {
		let calls = stubFetch((_call, index) =>
			json([], 200, { "x-next-page": String(index + 2) }),
		);
		expect(
			await gitlab.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "INCONCLUSIVE", cause: "unknown" });
		expect(calls).toHaveLength(10);
		calls = stubFetch(() =>
			json([
				gitlabMergeRequest({ iid: 5 }),
				gitlabMergeRequest({ iid: 6 }),
			]),
		);
		expect(
			await gitlab.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "INCONCLUSIVE", cause: "conflict" });
		expect(calls).toHaveLength(1);
	});

	it("encodes an already-encoded project path exactly once", async () => {
		const calls = stubFetch(() => json([]));
		await gitlab.findOperation({
			...target("example-org%2Fsub/example-repo"),
			sourceRef: BRANCH,
		});
		expect(calls[0]?.url.startsWith(`${PROJECT}/merge_requests?`)).toBe(
			true,
		);
	});
});

describe("GitLab open, get and close", () => {
	it("reads locked as open, merged as merged and closed as closed", async () => {
		for (const [state, expected] of [
			["locked", "OPEN"],
			["opened", "OPEN"],
			["merged", "MERGED"],
			["closed", "CLOSED"],
		] as const) {
			stubFetch(() => json(gitlabMergeRequest({ iid: 7, state })));
			expect(
				(await gitlab.get({ ...target(), externalId: "7" })).state,
			).toBe(expected);
		}
	});

	it("sends a description longer than Azure DevOps allows unchanged", async () => {
		const body = `${"n".repeat(4_200)}\n\n---\n\nOpened from Fabric`;
		const calls = stubFetch(() =>
			json(gitlabMergeRequest({ iid: 8 }), 201),
		);
		await gitlab.open({
			...target(),
			sourceRef: BRANCH,
			targetRef: "main",
			title: "t",
			body,
		});
		expect((calls[0]?.body as { description: string }).description).toBe(
			body,
		);
	});

	it("opens once with the documented body and marks a 409 as a duplicate", async () => {
		let calls = stubFetch(() => json(gitlabMergeRequest({ iid: 8 }), 201));
		await gitlab.open({
			...target(),
			sourceRef: BRANCH,
			targetRef: "main",
			title: "t",
			body: "b",
		});
		expect(calls[0]).toMatchObject({
			method: "POST",
			url: `${PROJECT}/merge_requests`,
			body: {
				source_branch: BRANCH,
				target_branch: "main",
				title: "t",
				description: "b",
				remove_source_branch: false,
			},
		});
		calls = stubFetch(() =>
			json(
				{
					message: [
						"Another open merge request already exists for this source branch: !8",
					],
				},
				409,
			),
		);
		await expect(
			gitlab.open({
				...target(),
				sourceRef: BRANCH,
				targetRef: "main",
				title: "t",
				body: "b",
			}),
		).rejects.toMatchObject({
			code: "PR_CREATION_REFUSED",
			duplicate: true,
		});
		expect(calls).toHaveLength(1);
	});

	it("closes with PUT state_event close", async () => {
		const calls = stubFetch(() =>
			json(gitlabMergeRequest({ iid: 9, state: "closed" })),
		);
		expect(
			(await gitlab.close({ ...target(), externalId: "9" })).state,
		).toBe("CLOSED");
		expect(calls[0]).toMatchObject({
			method: "PUT",
			url: `${PROJECT}/merge_requests/9`,
			body: { state_event: "close" },
		});
	});

	it("is the adapter for GITLAB", () => {
		expect(adapterFor("GITLAB")).toBe(gitlab);
	});
});
