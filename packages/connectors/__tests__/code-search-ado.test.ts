import { afterEach, describe, expect, it, vi } from "vitest";
import { searchRepositoryCode } from "../src/code-search";

/**
 * Regression: Azure DevOps code search must send the `Project` filter whenever
 * a `Repository` filter is present. ADO rejects Repository-without-Project with
 * a 400 ("Filter [Repository] is found but filter [Project] is not."), which
 * silently returned zero results for every ADO repo before the fix.
 */
describe("searchRepositoryCode (Azure DevOps) — Project filter", () => {
	afterEach(() => vi.restoreAllMocks());

	it("includes Project alongside Repository in the ADO search filters", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await searchRepositoryCode({
			provider: "AZURE_DEVOPS",
			token: "pat",
			owner: "myorg",
			repo: "myrepo",
			azureProject: "myproject",
			query: "main",
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(init.body as string);
		expect(body.filters).toMatchObject({
			Project: ["myproject"],
			Repository: ["myrepo"],
		});
	});

	it("returns [] (no throw) when azureProject is missing", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const results = await searchRepositoryCode({
			provider: "AZURE_DEVOPS",
			token: "pat",
			owner: "myorg",
			repo: "myrepo",
			query: "main",
		});
		expect(results).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
