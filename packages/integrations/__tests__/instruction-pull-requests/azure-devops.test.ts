import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	adapterFor,
	adoApiBase,
	azureDevOps,
	InstructionPullRequestError,
	type RepositoryIdentity,
	type Target,
} from "../../src/instruction-pull-requests";
import { adoPull, BRANCH, commit, json, PAT, stubFetch } from "./hand-built";

// Hand-built responses (see hand-built.ts); recorded fixtures are owed (R19).

function repository(
	over: Partial<
		Extract<RepositoryIdentity, { provider: "AZURE_DEVOPS" }>
	> = {},
): Extract<RepositoryIdentity, { provider: "AZURE_DEVOPS" }> {
	return {
		provider: "AZURE_DEVOPS",
		apiOrigin: "https://dev.azure.com",
		organization: "example-org",
		project: "Example%20Project",
		repository: "example-repo",
		...over,
	};
}

function target(
	authMethod: "PAT" | "OAUTH" = "PAT",
	repo = repository(),
): Target {
	return {
		auth: { token: PAT, authMethod },
		repository: repo,
		signal: new AbortController().signal,
	};
}

const PULLS =
	"https://dev.azure.com/example-org/Example%20Project/_apis/git/repositories/example-repo/pullrequests";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Azure DevOps hosts and paths", () => {
	it("encodes a project with a space exactly once", async () => {
		for (const project of ["Example%20Project", "Example Project"]) {
			const calls = stubFetch(() => json({ value: [], count: 0 }));
			await azureDevOps.findOperation({
				...target("PAT", repository({ project })),
				sourceRef: BRANCH,
			});
			expect(calls[0]?.url.startsWith(`${PULLS}?`)).toBe(true);
			expect(calls[0]?.url).not.toContain("%2520");
		}
	});

	it("accepts dev.azure.com and <org>.visualstudio.com only", () => {
		expect(adoApiBase(repository())).toBe(
			"https://dev.azure.com/example-org/Example%20Project",
		);
		expect(
			adoApiBase(
				repository({
					apiOrigin: "https://example-org.visualstudio.com",
				}),
			),
		).toBe("https://example-org.visualstudio.com/Example%20Project");
		for (const apiOrigin of [
			"http://dev.azure.com",
			"https://dev.azure.com:8443",
			`https://user@${"dev.azure.com"}`,
			"https://dev.azure.com/example-org",
			"https://example.com",
			"https://a.b.visualstudio.com",
			"https://dev.azure.com.example.com",
		]) {
			expect(() => adoApiBase(repository({ apiOrigin }))).toThrow();
		}
	});
});

describe("Azure DevOps findOperation", () => {
	// The pull-request list pages with $top/$skip and ends on a short page.
	// A continuation token is a paging scheme the adapter does not follow,
	// so it leaves the search incomplete rather than complete (spec §10).
	it("reports a response carrying a continuation token as INCONCLUSIVE", async () => {
		const calls = stubFetch(() =>
			json({ value: [adoPull({ id: 9 })], count: 1 }, 200, {
				"x-ms-continuationtoken": "opaque",
			}),
		);
		expect(
			await azureDevOps.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "INCONCLUSIVE", cause: "unknown" });
		expect(calls).toHaveLength(1);
	});

	it("pages with $skip across targets and states, and ignores a fork's pull request on the same branch name", async () => {
		const forks = Array.from({ length: 100 }, (_, n) =>
			adoPull({ id: 100 + n, fork: true }),
		);
		const calls = stubFetch((_call, index) =>
			index === 0
				? json({ value: forks, count: 100 })
				: json({
						value: [
							adoPull({
								id: 7,
								target: "release",
								status: "completed",
							}),
						],
						count: 1,
					}),
		);
		const found = await azureDevOps.findOperation({
			...target(),
			sourceRef: BRANCH,
		});
		expect(found).toEqual({
			kind: "FOUND",
			value: expect.objectContaining({
				externalId: "7",
				state: "MERGED",
				targetRef: "release",
				headSha: commit("ado-7"),
				mergeCommitSha: commit("ado-merge-7"),
				mergedAt: "2026-09-24T01:00:00Z",
				url: "https://dev.azure.com/example-org/Example%20Project/_git/example-repo/pullrequest/7",
			}),
		});
		expect(calls).toHaveLength(2);
		const first = new URL(calls[0]?.url as string);
		expect(first.searchParams.get("searchCriteria.sourceRefName")).toBe(
			`refs/heads/${BRANCH}`,
		);
		expect(first.searchParams.get("searchCriteria.status")).toBe("all");
		expect(first.searchParams.get("$top")).toBe("100");
		expect(first.searchParams.get("$skip")).toBe("0");
		expect(first.searchParams.get("api-version")).toBe("7.1");
		expect(new URL(calls[1]?.url as string).searchParams.get("$skip")).toBe(
			"100",
		);
	});

	it("ignores a fork's pull request on the same branch name", async () => {
		stubFetch(() => json({ value: [adoPull({ id: 1, fork: true })] }));
		expect(
			await azureDevOps.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "ABSENT" });
	});

	it("reports an 11-page list as INCONCLUSIVE after 10 pages", async () => {
		const page = Array.from({ length: 100 }, (_, n) =>
			adoPull({ id: 1000 + n, fork: true }),
		);
		const calls = stubFetch(() => json({ value: page }));
		expect(
			await azureDevOps.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "INCONCLUSIVE", cause: "unknown" });
		expect(calls).toHaveLength(10);
	});

	it("hydrates a list entry without its source commit", async () => {
		const calls = stubFetch((call) =>
			call.url.startsWith(`${PULLS}/3?`)
				? json(adoPull({ id: 3 }))
				: json({ value: [adoPull({ id: 3, sha: null })] }),
		);
		expect(
			(
				await azureDevOps.findOperation({
					...target(),
					sourceRef: BRANCH,
				})
			).kind,
		).toBe("FOUND");
		expect(calls).toHaveLength(2);
	});

	it("reads a 203 sign-in page as an authentication failure", async () => {
		stubFetch(
			() =>
				new Response("<html>sign in</html>", {
					status: 203,
					headers: { "content-type": "text/html" },
				}),
		);
		expect(
			await azureDevOps.findOperation({ ...target(), sourceRef: BRANCH }),
		).toEqual({ kind: "INCONCLUSIVE", cause: "auth" });
	});
});

describe("Azure DevOps open, get, close and credentials", () => {
	it("sends a PAT as Basic base64(':' + pat) and OAuth as Bearer", async () => {
		const calls = stubFetch(() => json(adoPull({ id: 4 })));
		await azureDevOps.get({ ...target("PAT"), externalId: "4" });
		await azureDevOps.get({ ...target("OAUTH"), externalId: "4" });
		expect(calls[0]?.headers.Authorization).toBe(
			`Basic ${Buffer.from(`:${PAT}`).toString("base64")}`,
		);
		expect(calls[1]?.headers.Authorization).toBe(`Bearer ${PAT}`);
		expect(calls[0]?.url).toBe(`${PULLS}/4?api-version=7.1`);
	});

	it("redacts the encoded PAT", async () => {
		const encoded = Buffer.from(`:${PAT}`).toString("base64");
		stubFetch(() => {
			throw new TypeError(
				`fetch failed: Authorization: Basic ${encoded} for ${PAT}`,
			);
		});
		const error = (await azureDevOps
			.get({ ...target(), externalId: "5" })
			.catch((e: unknown) => e)) as InstructionPullRequestError;
		expect(error).toBeInstanceOf(InstructionPullRequestError);
		const printed = [
			error.message,
			String(error.cause),
			JSON.stringify(error),
			inspect(error),
			String(error.stack),
		].join("\n");
		expect(printed).not.toContain(PAT);
		expect(printed).not.toContain(encoded);
		const lookup = await azureDevOps.findOperation({
			...target(),
			sourceRef: BRANCH,
		});
		expect(JSON.stringify(lookup)).not.toContain(encoded);
	});

	it("maps completed to merged and abandoned to closed, and closes by abandoning", async () => {
		stubFetch(() => json(adoPull({ id: 6, status: "completed" })));
		expect(
			(await azureDevOps.get({ ...target(), externalId: "6" })).state,
		).toBe("MERGED");
		const calls = stubFetch(() =>
			json(adoPull({ id: 6, status: "abandoned" })),
		);
		const closed = await azureDevOps.close({
			...target(),
			externalId: "6",
		});
		expect(closed).toMatchObject({
			state: "CLOSED",
			closedAt: "2026-09-24T01:00:00Z",
		});
		expect(calls[0]).toMatchObject({
			method: "PATCH",
			url: `${PULLS}/6?api-version=7.1`,
			body: { status: "abandoned" },
		});
	});

	it("fits an over-long description to Azure DevOps's 4000-character limit, footer intact", async () => {
		const footer =
			"Opened from Fabric project Example Project by Example Person";
		const body = `${"n".repeat(4_200)}\n\n---\n\n${footer}`;
		const calls = stubFetch(() => json(adoPull({ id: 12 }), 201));
		await azureDevOps.open({
			...target(),
			sourceRef: BRANCH,
			targetRef: "main",
			title: "t",
			body,
		});
		const description = (calls[0]?.body as { description: string })
			.description;
		expect(description.length).toBeLessThanOrEqual(4_000);
		expect(description.endsWith(`\n\n---\n\n${footer}`)).toBe(true);
	});

	it("opens once with refs/heads names and marks TF401179 as a duplicate", async () => {
		let calls = stubFetch(() => json(adoPull({ id: 8 }), 201));
		await azureDevOps.open({
			...target(),
			sourceRef: BRANCH,
			targetRef: "main",
			title: "t",
			body: "b",
		});
		expect(calls[0]).toMatchObject({
			method: "POST",
			url: `${PULLS}?api-version=7.1`,
			body: {
				sourceRefName: `refs/heads/${BRANCH}`,
				targetRefName: "refs/heads/main",
				title: "t",
				description: "b",
			},
		});
		calls = stubFetch(() =>
			json(
				{
					message:
						"TF401179: An active pull request for the source and target branch already exists.",
					typeKey: "GitPullRequestExistsException",
				},
				409,
			),
		);
		await expect(
			azureDevOps.open({
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

	it("is the adapter for AZURE_DEVOPS", () => {
		expect(adapterFor("AZURE_DEVOPS")).toBe(azureDevOps);
	});
});
