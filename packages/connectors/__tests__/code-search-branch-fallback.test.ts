import { afterEach, describe, expect, it, vi } from "vitest";
import { getRepositoryFile, listRepositoryStructure } from "../src/code-search";

/**
 * Regression (card 1844, Hypothesis 4): an unknown default branch must NOT fall
 * back to the literal "main" in the code-fetch path. A repo whose real default
 * is `master` (or anything else) 404s on `ref=main` and silently returns empty.
 *
 * The fix lets each provider resolve its OWN default when no branch is given:
 *   - GitHub: omit `ref` on the contents API; use `HEAD` on the git-trees API.
 *   - Azure DevOps: omit the `versionDescriptor.version`.
 * An explicit branch must still be honored.
 */

function okJson(body: unknown = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function requestedUrl(spy: ReturnType<typeof vi.spyOn>, call = 0): string {
	return String(spy.mock.calls[call]?.[0]);
}

describe("code-fetch branch fallback — GitHub", () => {
	afterEach(() => vi.restoreAllMocks());

	it("omits ref when the branch is unknown (serves the repo default)", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(okJson({ content: "", encoding: "base64" }));

		await getRepositoryFile({
			provider: "GITHUB",
			token: "t",
			owner: "o",
			repo: "r",
			path: "src/index.ts",
			branch: undefined,
		});

		const url = requestedUrl(fetchSpy);
		expect(url).not.toContain("ref=");
		expect(url).not.toContain("main");
	});

	it("sends the explicit branch as ref when provided", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(okJson({ content: "", encoding: "base64" }));

		await getRepositoryFile({
			provider: "GITHUB",
			token: "t",
			owner: "o",
			repo: "r",
			path: "src/index.ts",
			branch: "develop",
		});

		expect(requestedUrl(fetchSpy)).toContain("ref=develop");
	});

	it("lists the tree at HEAD when the branch is unknown", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(okJson({ tree: [] }));

		await listRepositoryStructure({
			provider: "GITHUB",
			token: "t",
			owner: "o",
			repo: "r",
			branch: undefined,
		});

		const url = requestedUrl(fetchSpy);
		expect(url).toContain("/git/trees/HEAD");
		expect(url).not.toContain("/git/trees/main");
	});

	it("lists the tree at the explicit branch when provided", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(okJson({ tree: [] }));

		await listRepositoryStructure({
			provider: "GITHUB",
			token: "t",
			owner: "o",
			repo: "r",
			branch: "develop",
		});

		expect(requestedUrl(fetchSpy)).toContain("/git/trees/develop");
	});
});

describe("code-fetch branch fallback — Azure DevOps", () => {
	afterEach(() => vi.restoreAllMocks());

	it("omits the version descriptor when the branch is unknown", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("file contents", { status: 200 }));

		await getRepositoryFile({
			provider: "AZURE_DEVOPS",
			token: "pat",
			owner: "org",
			repo: "r",
			azureProject: "proj",
			path: "src/index.ts",
			branch: undefined,
		});

		const url = decodeURIComponent(requestedUrl(fetchSpy));
		expect(url).not.toContain("versionDescriptor.version");
		expect(url).not.toContain("main");
	});

	it("sends the version descriptor when the branch is provided", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("file contents", { status: 200 }));

		await getRepositoryFile({
			provider: "AZURE_DEVOPS",
			token: "pat",
			owner: "org",
			repo: "r",
			azureProject: "proj",
			path: "src/index.ts",
			branch: "develop",
		});

		expect(decodeURIComponent(requestedUrl(fetchSpy))).toContain(
			"versionDescriptor.version=develop",
		);
	});

	it("omits the version descriptor when listing structure without a branch", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(okJson({ value: [] }));

		await listRepositoryStructure({
			provider: "AZURE_DEVOPS",
			token: "pat",
			owner: "org",
			repo: "r",
			azureProject: "proj",
			branch: undefined,
		});

		const url = decodeURIComponent(requestedUrl(fetchSpy));
		expect(url).not.toContain("versionDescriptor.version");
		expect(url).not.toContain("main");
	});
});
