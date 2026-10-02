/**
 * `readRepositoryBlobSizes` — the size of every file of one commit from the
 * provider's tree API, so a sync that stopped a checkout can state the real
 * size. Never throws; a failure or a listing that stops short is reported as
 * such so the caller falls back to a lower bound it labels as one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRepositoryBlobSizes } from "../repository-blob-sizes";

const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const SECRET_TOKEN = "ghs_example_sizes_secret";
const COMMIT = "c".repeat(40);
const TREE = "t".repeat(40);

const githubInput = {
	provider: "GITHUB" as const,
	token: SECRET_TOKEN,
	repositoryUrl: "https://github.com/example-org/instructions",
	owner: "example-org",
	repo: "instructions",
	commitSha: COMMIT,
	rootTreeId: TREE,
};

const adoInput = {
	provider: "AZURE_DEVOPS" as const,
	token: SECRET_TOKEN,
	repositoryUrl: "https://dev.azure.com/example-org/Proj/_git/instructions",
	owner: "example-org",
	repo: "instructions",
	azureOrganization: "example-org",
	commitSha: COMMIT,
	rootTreeId: TREE,
};

function jsonResponse(status: number, value: unknown) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("readRepositoryBlobSizes — GitHub", () => {
	it("reads every blob's size from the recursive tree of the commit", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				truncated: false,
				tree: [
					{ path: "docs", type: "tree" },
					{ path: "docs/a.md", type: "blob", size: 5_243_904 },
					{ path: "b.md", type: "blob", size: 3 },
					{ path: "vendor", type: "commit" },
				],
			}),
		);

		const result = await readRepositoryBlobSizes(githubInput);

		expect(result).toEqual({
			ok: true,
			complete: true,
			sizes: new Map([
				["docs/a.md", 5_243_904],
				["b.md", 3],
			]),
		});
		const [url, init] = mockFetch.mock.calls[0] as [
			string,
			{ headers: Record<string, string> },
		];
		expect(url).toBe(
			`https://api.github.com/repos/example-org/instructions/git/trees/${COMMIT}?recursive=1`,
		);
		expect(init.headers.Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
	});

	it("says a truncated listing is incomplete", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				truncated: true,
				tree: [{ path: "a.md", type: "blob", size: 1 }],
			}),
		);

		expect(await readRepositoryBlobSizes(githubInput)).toMatchObject({
			ok: true,
			complete: false,
		});
	});

	it("reports a failed request as not ok, never as an empty listing", async () => {
		mockFetch.mockResolvedValue(jsonResponse(403, { message: "no" }));
		expect(await readRepositoryBlobSizes(githubInput)).toEqual({
			ok: false,
		});

		mockFetch.mockRejectedValue(new Error("network down"));
		expect(await readRepositoryBlobSizes(githubInput)).toEqual({
			ok: false,
		});
	});

	it("reports a body that is not a tree as not ok", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200, { nothing: true }));
		expect(await readRepositoryBlobSizes(githubInput)).toEqual({
			ok: false,
		});
	});
});

describe("readRepositoryBlobSizes — Azure DevOps", () => {
	it("reads every blob's size from the recursive Trees - Get of the root tree", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				objectId: TREE,
				treeEntries: [
					{ relativePath: "Home", gitObjectType: "tree", size: 259 },
					{
						relativePath: "Home/Index.md",
						gitObjectType: "blob",
						size: 2690,
					},
					{
						relativePath: "Web.md",
						gitObjectType: "blob",
						size: 1670,
					},
				],
			}),
		);

		const result = await readRepositoryBlobSizes(adoInput);

		expect(result).toEqual({
			ok: true,
			complete: true,
			sizes: new Map([
				["Home/Index.md", 2690],
				["Web.md", 1670],
			]),
		});
		const [url, init] = mockFetch.mock.calls[0] as [
			string,
			{ headers: Record<string, string> },
		];
		expect(url).toBe(
			`https://dev.azure.com/example-org/Proj/_apis/git/repositories/instructions/trees/${TREE}?recursive=true&api-version=7.1`,
		);
		expect(init.headers.Authorization).toBe(
			`Basic ${Buffer.from(`:${SECRET_TOKEN}`).toString("base64")}`,
		);
	});

	it("reads the 203 sign-in page as a rejected credential, not a listing", async () => {
		mockFetch.mockResolvedValue(
			new Response("<html>sign in</html>", { status: 203 }),
		);

		expect(await readRepositoryBlobSizes(adoInput)).toEqual({ ok: false });
	});

	it("reports an entry list that is missing as not ok", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200, { objectId: TREE }));
		expect(await readRepositoryBlobSizes(adoInput)).toEqual({ ok: false });
	});
});

describe("readRepositoryBlobSizes — other providers", () => {
	it("does not call out for GitLab", async () => {
		const result = await readRepositoryBlobSizes({
			...githubInput,
			provider: "GITLAB",
		});

		expect(result).toEqual({ ok: false });
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
