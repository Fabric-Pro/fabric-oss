import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getRepositoryFile,
	listRepositoryStructure,
	searchRepositoryCode,
} from "../src/code-search";

/**
 * A failed file or tree read used to come back exactly like an empty result,
 * so callers reported a 403, a 401, a rate limit or a provider outage as "not
 * found" / "no files". A failed read now carries `error` with its kind and
 * HTTP status; a genuine 404 is still `not_found`, and a successful read has
 * no `error` at all.
 */

const GITHUB = {
	provider: "GITHUB" as const,
	token: "t",
	owner: "example-org",
	repo: "app",
};
const ADO = {
	provider: "AZURE_DEVOPS" as const,
	token: "t",
	owner: "example-org",
	repo: "app",
	azureProject: "example-project",
};

function status(code: number, headers: Record<string, string> = {}) {
	return new Response("{}", { status: code, headers });
}

describe("getRepositoryFile — failed reads are distinguishable", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([
		[GITHUB, 403, {}, "forbidden"],
		[GITHUB, 401, {}, "unauthorized"],
		[GITHUB, 429, {}, "rate_limited"],
		[GITHUB, 403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
		[GITHUB, 502, {}, "provider_error"],
		[GITHUB, 404, {}, "not_found"],
		[ADO, 403, {}, "forbidden"],
		[ADO, 401, {}, "unauthorized"],
		[ADO, 503, {}, "provider_error"],
		[ADO, 404, {}, "not_found"],
	] as const)("%o HTTP %i → %s", async (repo, code, headers, kind) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(status(code, headers));
		const file = await getRepositoryFile({
			...repo,
			path: "src/index.ts",
		});
		expect(file.content).toBe("");
		expect(file.error).toMatchObject({ kind, status: code });
		expect(file.error?.message).toContain(String(code));
	});

	it("reports a thrown network failure as request_failed, without the exception text", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("getaddrinfo ENOTFOUND api.github.com"),
		);
		const file = await getRepositoryFile({ ...GITHUB, path: "src/a.ts" });
		expect(file.error).toMatchObject({ kind: "request_failed" });
		// Fixed text: an exception message can carry the URL and its token.
		expect(file.error?.message).not.toContain("ENOTFOUND");
	});

	it("leaves error unset on a successful read", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					content: Buffer.from("export {};").toString("base64"),
					encoding: "base64",
					size: 10,
				}),
				{ status: 200 },
			),
		);
		const file = await getRepositoryFile({ ...GITHUB, path: "src/a.ts" });
		expect(file.content).toBe("export {};");
		expect(file.error).toBeUndefined();
	});
});

describe("listRepositoryStructure — failed listings are distinguishable", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([
		[GITHUB, 403, "forbidden"],
		[GITHUB, 401, "unauthorized"],
		[GITHUB, 500, "provider_error"],
		[GITHUB, 404, "not_found"],
		[ADO, 403, "forbidden"],
		[ADO, 429, "rate_limited"],
	] as const)("%o HTTP %i → %s", async (repo, code, kind) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(status(code));
		const structure = await listRepositoryStructure(repo);
		expect(structure.entries).toEqual([]);
		expect(structure.error).toMatchObject({ kind, status: code });
	});

	it("names a missing Azure DevOps project instead of returning a silent empty tree", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const structure = await listRepositoryStructure({
			...ADO,
			azureProject: undefined,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(structure.error).toMatchObject({ kind: "misconfigured" });
	});

	it("leaves error unset on a successful listing, even an empty one", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ tree: [], truncated: false }), {
				status: 200,
			}),
		);
		const structure = await listRepositoryStructure(GITHUB);
		expect(structure.entries).toEqual([]);
		expect(structure.error).toBeUndefined();
	});
});

describe("searchRepositoryCode — a failed search is not 'no matches'", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([
		[GITHUB, 401, {}, "unauthorized"],
		[GITHUB, 403, {}, "forbidden"],
		[GITHUB, 429, {}, "rate_limited"],
		[GITHUB, 403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
		[GITHUB, 500, {}, "provider_error"],
		[ADO, 401, {}, "unauthorized"],
		[ADO, 203, {}, "unauthorized"],
		[ADO, 503, {}, "provider_error"],
	] as const)("%o HTTP %i → %s", async (repo, code, headers, kind) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(status(code, headers));
		const response = await searchRepositoryCode({
			...repo,
			query: "login",
		});
		expect(response.results).toEqual([]);
		expect(response.error).toMatchObject({ kind, status: code });
		expect(response.error?.message).toContain(String(code));
	});

	it("names a missing Azure DevOps project as misconfigured, without calling the provider", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const { azureProject: _omitted, ...withoutProject } = ADO;
		const response = await searchRepositoryCode({
			...withoutProject,
			query: "login",
		});
		expect(response.results).toEqual([]);
		expect(response.error).toMatchObject({ kind: "misconfigured" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reports a thrown fetch as request_failed, without the exception text", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("getaddrinfo ENOTFOUND api.github.com"),
		);
		const response = await searchRepositoryCode({
			...GITHUB,
			query: "login",
		});
		expect(response.results).toEqual([]);
		expect(response.error).toMatchObject({ kind: "request_failed" });
		expect(response.error?.message).not.toContain("ENOTFOUND");
	});

	it("reports an unsupported provider as misconfigured", async () => {
		const response = await searchRepositoryCode({
			provider: "GITLAB",
			token: "t",
			owner: "example-org",
			repo: "app",
			query: "login",
		} as never);
		expect(response.results).toEqual([]);
		expect(response.error).toMatchObject({ kind: "misconfigured" });
	});

	it("never puts the response body or status text in the message", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("token=secret-value", {
				status: 500,
				statusText: "secret-status-text",
			}),
		);
		const response = await searchRepositoryCode({
			...GITHUB,
			query: "login",
		});
		expect(response.error?.message).not.toContain("secret");
	});

	it("leaves error unset on a successful GitHub search", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [
						{
							name: "a.ts",
							path: "src/a.ts",
							html_url: "https://example.com/a.ts",
							repository: { full_name: "example-org/app" },
							text_matches: [{ fragment: "login()" }],
						},
					],
				}),
				{ status: 200 },
			),
		);
		const response = await searchRepositoryCode({
			...GITHUB,
			query: "login",
		});
		expect(response.results).toHaveLength(1);
		expect(response).not.toHaveProperty("error");
	});

	it("leaves error unset when a search ran and found nothing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ items: [] }), { status: 200 }),
		);
		const response = await searchRepositoryCode({
			...GITHUB,
			query: "login",
		});
		expect(response).toEqual({ results: [] });
	});

	it("leaves error unset on a successful Azure DevOps search", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							fileName: "a.ts",
							path: "/src/a.ts",
							repository: { name: "app" },
						},
					],
				}),
				{ status: 200 },
			),
		);
		const response = await searchRepositoryCode({ ...ADO, query: "login" });
		expect(response.results).toHaveLength(1);
		expect(response).not.toHaveProperty("error");
	});
});
