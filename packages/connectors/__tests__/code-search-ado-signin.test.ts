import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compareRepositoryCommits,
	getRepositoryFile,
	listRepositoryStructure,
	searchRepositoryCode,
} from "../src/code-search";

/**
 * Azure DevOps answers an invalid or expired PAT with HTTP 203 and an HTML
 * sign-in page. 203 is in the 2xx range, so `response.ok` is true; every
 * Azure DevOps call here must treat it as rejected credentials before
 * reading the body — never as file content, an empty tree, or JSON to parse.
 * Same precedent as repository-api.ts and repository-file.ts.
 */

const ADO = {
	provider: "AZURE_DEVOPS" as const,
	token: "t",
	owner: "example-org",
	repo: "app",
	azureProject: "example-project",
};

const SIGN_IN_PAGE =
	"<!DOCTYPE html><html><head><title>Sign in to your account</title></head><body>Sign in</body></html>";

/** A 203 sign-in page whose body readers are spied on. */
function signInResponse() {
	const response = new Response(SIGN_IN_PAGE, {
		status: 203,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
	const json = vi.spyOn(response, "json");
	const text = vi.spyOn(response, "text");
	vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
	return { json, text };
}

afterEach(() => vi.restoreAllMocks());

describe("Azure DevOps HTTP 203 (sign-in page) is rejected credentials", () => {
	it("file read: unauthorized error, not the sign-in HTML as content", async () => {
		const { json, text } = signInResponse();
		const file = await getRepositoryFile({ ...ADO, path: "README.md" });
		expect(file.content).toBe("");
		expect(file.error).toMatchObject({ kind: "unauthorized", status: 203 });
		expect(file.error?.message).toMatch(/Azure DevOps credentials/);
		expect(file.error?.message).not.toContain("Sign in");
		expect(json).not.toHaveBeenCalled();
		expect(text).not.toHaveBeenCalled();
	});

	it("structure read: unauthorized error, not an empty success", async () => {
		const { json } = signInResponse();
		const structure = await listRepositoryStructure(ADO);
		expect(structure.entries).toEqual([]);
		expect(structure.error).toMatchObject({
			kind: "unauthorized",
			status: 203,
		});
		expect(json).not.toHaveBeenCalled();
	});

	it("search: takes the failure branch without parsing the HTML", async () => {
		const { json } = signInResponse();
		const { results } = await searchRepositoryCode({
			...ADO,
			query: "login",
		});
		expect(results).toEqual([]);
		expect(json).not.toHaveBeenCalled();
	});

	it("commit compare: unknown, without parsing the HTML", async () => {
		const { json } = signInResponse();
		const result = await compareRepositoryCommits({
			...ADO,
			base: "abc1234",
			head: "main",
		});
		expect(result.status).toBe("unknown");
		expect(json).not.toHaveBeenCalled();
	});
});
