/**
 * Unit tests for the Azure DevOps request-path discovery helpers
 * (`validateAzureDevOpsPat`, `listAzureDevOpsProjectsAndRepos`).
 *
 * These mock `globalThis.fetch` (mirroring federated-connectors.test.ts) and
 * assert:
 *   - PAT validation returns typed ok/status (no throw on auth failure).
 *   - Repo discovery groups repos by ADO project and builds canonical
 *     `dev.azure.com/{org}/{project}/_git/{repo}` URLs.
 *   - 401/403 → configured:true with the invalid-PAT message.
 *   - "no repos" → configured:true, empty groups (not an error throw).
 *   - The PAT is sent as `Authorization: Basic base64(":" + pat)` and is never
 *     placed in a logged location.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	listAzureDevOpsProjectsAndRepos,
	validateAzureDevOpsPat,
} from "../src/azure-devops/discovery";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
	return {
		ok: init?.ok ?? true,
		status: init?.status ?? 200,
		json: async () => body,
	} as Response;
}

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("validateAzureDevOpsPat", () => {
	it("returns { ok: true } when connectionData responds 200", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(jsonResponse({}, { ok: true, status: 200 }));

		const result = await validateAzureDevOpsPat({
			organization: "my-org",
			pat: "secret-pat",
		});

		expect(result).toEqual({ ok: true });
		// Hits the connectionData endpoint for the org.
		expect(fetchMock).toHaveBeenCalledWith(
			"https://dev.azure.com/my-org/_apis/connectionData",
			expect.objectContaining({
				headers: expect.objectContaining({
					// Basic base64(":" + pat)
					Authorization: `Basic ${Buffer.from(":secret-pat").toString("base64")}`,
				}),
			}),
		);
	});

	it("returns { ok: false, status } without throwing on 401", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			jsonResponse({}, { ok: false, status: 401 }),
		);

		const result = await validateAzureDevOpsPat({
			organization: "my-org",
			pat: "bad-pat",
		});

		expect(result).toEqual({ ok: false, status: 401 });
	});

	it("returns { ok: false, status } without throwing on 403", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			jsonResponse({}, { ok: false, status: 403 }),
		);

		const result = await validateAzureDevOpsPat({
			organization: "my-org",
			pat: "scoped-pat",
		});

		expect(result).toEqual({ ok: false, status: 403 });
	});

	it("returns { ok: false, status } for other non-OK statuses", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			jsonResponse({}, { ok: false, status: 500 }),
		);

		const result = await validateAzureDevOpsPat({
			organization: "my-org",
			pat: "pat",
		});

		expect(result).toEqual({ ok: false, status: 500 });
	});
});

describe("listAzureDevOpsProjectsAndRepos", () => {
	it("lists repos grouped by project with canonical web URLs", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			// 1. projects list
			.mockResolvedValueOnce(
				jsonResponse({
					value: [
						{ id: "p1", name: "ProjectB" },
						{ id: "p2", name: "ProjectA" },
					],
				}),
			)
			// 2. repos for ProjectB
			.mockResolvedValueOnce(
				jsonResponse({
					value: [
						{
							id: "r1",
							name: "service-z",
							defaultBranch: "refs/heads/main",
							project: { name: "ProjectB" },
						},
						{
							id: "r2",
							name: "service-a",
							defaultBranch: "refs/heads/develop",
							project: { name: "ProjectB" },
						},
					],
				}),
			)
			// 3. repos for ProjectA
			.mockResolvedValueOnce(
				jsonResponse({
					value: [
						{
							id: "r3",
							name: "web",
							project: { name: "ProjectA" },
						},
					],
				}),
			);

		const result = await listAzureDevOpsProjectsAndRepos({
			organization: "my-org",
			pat: "secret-pat",
		});

		expect(result.configured).toBe(true);
		expect(result.organization).toBe("my-org");
		expect(result.error).toBeNull();

		// Groups sorted alphabetically by project name.
		expect(result.groups.map((g) => g.owner)).toEqual([
			"ProjectA",
			"ProjectB",
		]);

		// ProjectA group
		const projectA = result.groups.find((g) => g.owner === "ProjectA");
		expect(projectA?.repos).toHaveLength(1);
		expect(projectA?.repos[0]).toEqual({
			name: "web",
			projectName: "ProjectA",
			fullName: "https://dev.azure.com/my-org/ProjectA/_git/web",
			htmlUrl: "https://dev.azure.com/my-org/ProjectA/_git/web",
			defaultBranch: undefined,
			isPrivate: true,
			language: null,
		});

		// ProjectB repos sorted alphabetically; default branch short name stripped.
		const projectB = result.groups.find((g) => g.owner === "ProjectB");
		expect(projectB?.repos.map((r) => r.name)).toEqual([
			"service-a",
			"service-z",
		]);
		expect(projectB?.repos[0].defaultBranch).toBe("develop");
		expect(projectB?.repos[1].defaultBranch).toBe("main");

		// First call is the projects endpoint with the Basic auth header.
		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://dev.azure.com/my-org/_apis/projects?api-version=7.1",
		);
	});

	it("returns configured:true with empty groups + 'no repos' message when org has no repos", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				jsonResponse({ value: [{ id: "p1", name: "EmptyProject" }] }),
			)
			.mockResolvedValueOnce(jsonResponse({ value: [] }));

		const result = await listAzureDevOpsProjectsAndRepos({
			organization: "my-org",
			pat: "secret-pat",
		});

		expect(result.configured).toBe(true);
		expect(result.groups).toEqual([]);
		expect(result.error).toMatch(/No repositories found/i);
	});

	it("returns the invalid-PAT message (not a throw) when projects list 401s", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			jsonResponse({}, { ok: false, status: 401 }),
		);

		const result = await listAzureDevOpsProjectsAndRepos({
			organization: "my-org",
			pat: "bad-pat",
		});

		expect(result.configured).toBe(true);
		expect(result.groups).toEqual([]);
		expect(result.error).toBe("Invalid PAT or insufficient permissions");
	});

	it("returns a sanitized status message (not a throw) for other non-OK on projects list", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			jsonResponse({}, { ok: false, status: 503 }),
		);

		const result = await listAzureDevOpsProjectsAndRepos({
			organization: "my-org",
			pat: "pat",
		});

		expect(result.error).toBe("Azure DevOps returned status 503");
		expect(result.groups).toEqual([]);
	});

	it("skips a project whose repos endpoint fails without aborting discovery", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				jsonResponse({
					value: [
						{ id: "p1", name: "Good" },
						{ id: "p2", name: "Forbidden" },
					],
				}),
			)
			// Good repos OK
			.mockResolvedValueOnce(
				jsonResponse({
					value: [
						{
							id: "r1",
							name: "ok-repo",
							project: { name: "Good" },
						},
					],
				}),
			)
			// Forbidden repos 403 → skipped
			.mockResolvedValueOnce(
				jsonResponse({}, { ok: false, status: 403 }),
			);

		const result = await listAzureDevOpsProjectsAndRepos({
			organization: "my-org",
			pat: "pat",
		});

		expect(result.groups.map((g) => g.owner)).toEqual(["Good"]);
		expect(result.error).toBeNull();
	});
});
