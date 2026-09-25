import { afterEach, describe, expect, it, vi } from "vitest";
import {
	adapterFor,
	github,
	InstructionPullRequestError,
	LOOKUP_TIMEOUT_MS,
	OPEN_TIMEOUT_MS,
	type Target,
} from "../../src/instruction-pull-requests";
import {
	BRANCH,
	commit,
	githubPull,
	json,
	stubFetch,
	TOKEN,
} from "./hand-built";

// Hand-built responses (see hand-built.ts); recorded fixtures are owed (R19).

function target(signal: AbortSignal = new AbortController().signal): Target {
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

const API = "https://api.github.com/repos/example-org/example-repo/pulls";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("GitHub findOperation", () => {
	it("pages to the last page across targets and states, keeping only the frozen repository's pull request", async () => {
		const calls = stubFetch((_call, index) =>
			index === 0
				? json(
						[
							githubPull({
								number: 1,
								headFullName: "example-fork/example-repo",
							}),
						],
						200,
						{
							link: `<${API}?head=x&state=all&per_page=100&page=2>; rel="next"`,
						},
					)
				: json([
						githubPull({
							number: 2,
							base: "release",
							state: "closed",
							merged: true,
						}),
					]),
		);
		const found = await github.findOperation({
			...target(),
			sourceRef: BRANCH,
		});
		expect(found).toEqual({
			kind: "FOUND",
			value: expect.objectContaining({
				externalId: "2",
				state: "MERGED",
				targetRef: "release",
				sourceRef: BRANCH,
				headSha: commit("head-2"),
				mergeCommitSha: commit("merge-2"),
				url: "https://github.com/example-org/example-repo/pull/2",
			}),
		});
		expect(calls).toHaveLength(2);
		const first = new URL(calls[0]?.url as string);
		expect(first.origin + first.pathname).toBe(API);
		expect(first.searchParams.get("head")).toBe(`example-org:${BRANCH}`);
		expect(first.searchParams.get("state")).toBe("all");
		expect(first.searchParams.get("per_page")).toBe("100");
		expect(first.searchParams.has("base")).toBe(false);
		expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(calls[0]?.redirect).toBe("manual");
	});

	it("reports INCONCLUSIVE after 10 pages", async () => {
		const calls = stubFetch(() =>
			json([], 200, {
				link: `<${API}?page=next>; rel="next"`,
			}),
		);
		expect(
			await github.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "INCONCLUSIVE", cause: "unknown" });
		expect(calls).toHaveLength(10);
	});

	// Only GitHub's own end condition, no rel="next" link, completes a
	// search: a continuation it cannot follow leaves the search incomplete,
	// and an incomplete ABSENT would let recovery create a second pull
	// request (spec §10).
	it("never follows a next link to another origin, and reports the search INCONCLUSIVE", async () => {
		const calls = stubFetch(() =>
			json([], 200, {
				link: '<https://elsewhere.example.com/pulls?page=2>; rel="next"',
			}),
		);
		expect(
			await github.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "INCONCLUSIVE", cause: "unknown" });
		expect(calls).toHaveLength(1);
	});

	it.each([
		["an unparsable next URL", '<http://[bad>; rel="next"'],
		[
			"a next link on another path",
			'<https://api.github.com/repos/example-org/other-repo/pulls?page=2>; rel="next"',
		],
		["a next link with no angle brackets", `${API}?page=2; rel="next"`],
		[
			"two next links",
			`<${API}?page=2>; rel="next", <${API}?page=3>; rel="next"`,
		],
		["a part that is not a link", `<${API}?page=2>; rel="next", garbage`],
	])(
		"reports %s as INCONCLUSIVE, even after a candidate",
		async (_label, link) => {
			const calls = stubFetch(() =>
				json([githubPull({ number: 3 })], 200, { link }),
			);
			expect(
				await github.findOperation({ ...target(), sourceRef: BRANCH }),
			).toEqual({ kind: "INCONCLUSIVE", cause: "unknown" });
			expect(calls).toHaveLength(1);
		},
	);

	it('ends the search on a Link header without rel="next"', async () => {
		const calls = stubFetch(() =>
			json([githubPull({ number: 4 })], 200, {
				link: `<${API}?page=1>; rel="first", <${API}?page=1>; rel="prev"`,
			}),
		);
		expect(
			(await github.findOperation({ ...target(), sourceRef: BRANCH }))
				.kind,
		).toBe("FOUND");
		expect(calls).toHaveLength(1);
	});

	it("hydrates through get when a list entry lacks the source repository or head SHA", async () => {
		const calls = stubFetch((call) =>
			call.url.startsWith(`${API}/7`)
				? json(githubPull({ number: 7 }))
				: json([
						githubPull({
							number: 7,
							headFullName: null,
							sha: null,
						}),
					]),
		);
		const found = await github.findOperation({
			...target(),
			sourceRef: BRANCH,
		});
		expect(found.kind).toBe("FOUND");
		expect(calls.map((c) => c.url)).toEqual([
			expect.stringContaining("?head="),
			`${API}/7`,
		]);
	});

	it("reports several candidates as INCONCLUSIVE (conflict)", async () => {
		stubFetch(() =>
			json([
				githubPull({ number: 1 }),
				githubPull({ number: 2, base: "dev" }),
			]),
		);
		expect(
			await github.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "INCONCLUSIVE", cause: "conflict" });
	});

	it("ignores a fork's pull request on the same branch name", async () => {
		stubFetch(() =>
			json([
				githubPull({
					number: 3,
					headFullName: "example-fork/example-repo",
				}),
			]),
		);
		expect(
			await github.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "ABSENT" });
	});

	it("ignores a pull request whose head is another branch", async () => {
		stubFetch(() => json([githubPull({ number: 4, ref: `${BRANCH}-2` })]));
		expect(
			await github.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "ABSENT" });
	});

	it.each([
		[401, {}, "auth", undefined],
		[403, {}, "permission", undefined],
		[
			403,
			{ "x-ratelimit-remaining": "0", "retry-after": "90" },
			"rate_limit",
			90,
		],
		[429, { "retry-after": "30" }, "rate_limit", 30],
		[404, {}, "not_found", undefined],
		[502, {}, "transient", undefined],
	] as const)(
		"reports HTTP %i as INCONCLUSIVE with its cause",
		async (status, headers, cause, retryAfterSeconds) => {
			stubFetch(() =>
				json({ message: "sanitized away" }, status, headers),
			);
			expect(
				await github.findOperation({ ...target(), sourceRef: BRANCH }),
			).toEqual({
				kind: "INCONCLUSIVE",
				cause,
				...(retryAfterSeconds === undefined
					? {}
					: { retryAfterSeconds }),
			});
		},
	);

	it("reads a rate-limit reset epoch when there is no Retry-After", async () => {
		const reset = Math.floor(Date.now() / 1000) + 120;
		stubFetch(() =>
			json({}, 403, {
				"x-ratelimit-remaining": "0",
				"x-ratelimit-reset": String(reset),
			}),
		);
		const result = await github.findOperation({
			...target(),
			sourceRef: BRANCH,
		});
		expect(result.kind).toBe("INCONCLUSIVE");
		expect(
			result.kind === "INCONCLUSIVE" && result.retryAfterSeconds,
		).toBeGreaterThan(100);
	});

	it("reports a redirect to another origin as unknown, and follows one on its own origin", async () => {
		stubFetch(
			() =>
				new Response(null, {
					status: 302,
					headers: {
						location: "https://elsewhere.example.com/pulls",
					},
				}),
		);
		expect(
			await github.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "INCONCLUSIVE", cause: "unknown" });
		const calls = stubFetch((_call, index) =>
			index === 0
				? new Response(null, {
						status: 301,
						headers: {
							location:
								"https://api.github.com/repositories/1/pulls?head=x&state=all",
						},
					})
				: json([githubPull({ number: 5 })]),
		);
		expect(
			(await github.findOperation({ ...target(), sourceRef: BRANCH }))
				.kind,
		).toBe("FOUND");
		expect(calls[1]?.url).toBe(
			"https://api.github.com/repositories/1/pulls?head=x&state=all",
		);
	});
});

describe("GitHub open, get and close", () => {
	const openInput = {
		sourceRef: BRANCH,
		targetRef: "main",
		title: "Update coding instructions",
		body: "Opened from Fabric",
	};

	it("sends a body longer than Azure DevOps allows unchanged", async () => {
		const body = `${"n".repeat(4_200)}\n\n---\n\nOpened from Fabric`;
		const calls = stubFetch(() => json(githubPull({ number: 9 }), 201));
		await github.open({ ...target(), ...openInput, body });
		expect((calls[0]?.body as { body: string }).body).toBe(body);
	});

	it("opens with the documented body, once", async () => {
		const calls = stubFetch(() => json(githubPull({ number: 9 }), 201));
		const opened = await github.open({ ...target(), ...openInput });
		expect(opened).toMatchObject({ externalId: "9", state: "OPEN" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe(API);
		expect(calls[0]?.body).toEqual({
			title: "Update coding instructions",
			head: BRANCH,
			base: "main",
			body: "Opened from Fabric",
			maintainer_can_modify: false,
		});
	});

	it("never retries open on a 502, and reports the outcome as unknown", async () => {
		const calls = stubFetch(() => json({}, 502));
		const error = await github
			.open({ ...target(), ...openInput })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(InstructionPullRequestError);
		expect(error).toMatchObject({
			code: "CREATE_OUTCOME_UNKNOWN",
			retryable: true,
			cause: "transient",
		});
		expect(calls).toHaveLength(1);
	});

	it("never retries open when the request times out", async () => {
		const calls = stubFetch(() => {
			throw new DOMException("The operation timed out", "TimeoutError");
		});
		await expect(
			github.open({ ...target(), ...openInput }),
		).rejects.toMatchObject({ code: "CREATE_OUTCOME_UNKNOWN" });
		expect(calls).toHaveLength(1);
	});

	it("rethrows the activity's cancellation as itself", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled by the activity");
		stubFetch(() => {
			controller.abort(reason);
			throw new DOMException("aborted", "AbortError");
		});
		await expect(
			github.open({ ...target(controller.signal), ...openInput }),
		).rejects.toBe(reason);
	});

	it("marks a duplicate refusal", async () => {
		stubFetch(() =>
			json(
				{
					message: "Validation Failed",
					errors: [
						{
							resource: "PullRequest",
							code: "custom",
							message: `A pull request already exists for example-org:${BRANCH}.`,
						},
					],
				},
				422,
			),
		);
		const error = await github
			.open({ ...target(), ...openInput })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({
			code: "PR_CREATION_REFUSED",
			retryable: false,
			duplicate: true,
		});
		expect(JSON.stringify(error)).not.toContain("already exists");
	});

	it("reports another 422 as a definitive refusal, without the duplicate flag", async () => {
		stubFetch(() =>
			json({ message: "No commits between main and head" }, 422),
		);
		const error = (await github
			.open({ ...target(), ...openInput })
			.catch((e: unknown) => e)) as InstructionPullRequestError;
		expect(error.code).toBe("PR_CREATION_REFUSED");
		expect(error.duplicate).toBeUndefined();
	});

	it("maps closed-unmerged to CLOSED and closes with PATCH state closed", async () => {
		const calls = stubFetch(() =>
			json(githubPull({ number: 11, state: "closed" })),
		);
		const closed = await github.close({ ...target(), externalId: "11" });
		expect(closed).toMatchObject({ state: "CLOSED", externalId: "11" });
		expect(closed.mergeCommitSha).toBeUndefined();
		expect(calls[0]).toMatchObject({
			method: "PATCH",
			url: `${API}/11`,
			body: { state: "closed" },
		});
	});

	it("gets one pull request and reports a failure's cause without its body", async () => {
		stubFetch(() => json({ message: `secret ${TOKEN}` }, 401));
		const error = (await github
			.get({ ...target(), externalId: "12" })
			.catch((e: unknown) => e)) as InstructionPullRequestError;
		expect(error).toMatchObject({
			code: "AUTHENTICATION_FAILED",
			cause: "auth",
			retryable: true,
		});
		expect(
			`${error.message} ${JSON.stringify(error)} ${String(error.cause)}`,
		).not.toContain(TOKEN);
	});

	it("uses a 20 s timeout for lookups and 60 s for open, combined with the activity's signal", async () => {
		const timeouts = vi.spyOn(AbortSignal, "timeout");
		const controller = new AbortController();
		const calls = stubFetch(() => json(githubPull({ number: 13 })));
		await github.get({ ...target(controller.signal), externalId: "13" });
		await github.open({ ...target(controller.signal), ...openInput });
		expect(timeouts.mock.calls.map((c) => c[0])).toEqual([
			LOOKUP_TIMEOUT_MS,
			OPEN_TIMEOUT_MS,
		]);
		expect(LOOKUP_TIMEOUT_MS).toBe(20_000);
		expect(OPEN_TIMEOUT_MS).toBe(60_000);
		const signal = calls[0]?.signal as AbortSignal;
		expect(signal.aborted).toBe(false);
		controller.abort();
		expect(signal.aborted).toBe(true);
	});

	it("is the adapter for GITHUB", () => {
		expect(adapterFor("GITHUB")).toBe(github);
	});
});
