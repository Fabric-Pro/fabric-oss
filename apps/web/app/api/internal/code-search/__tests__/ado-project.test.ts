/**
 * Unit tests for `extractAdoProject` — the URL-derived `azureProject` segment
 * used by the live ADO code-search API.
 *
 * Covers the modern `dev.azure.com/{org}/{project}/_git/{repo}` shape, the
 * legacy `*.visualstudio.com/{project}/_git/{repo}` shape, dot-containing repo
 * names, and the "undefined → azureOrganization fallback" contract that the
 * route applies (`route.ts` resolves `extractAdoProject(url) ?? azureOrganization`).
 */

import { describe, expect, it } from "vitest";
import { extractAdoProject } from "../ado-project";

describe("extractAdoProject", () => {
	it("extracts the project from a modern dev.azure.com URL", () => {
		expect(
			extractAdoProject(
				"https://dev.azure.com/my-org/MyProject/_git/my-repo",
			),
		).toBe("MyProject");
	});

	it("extracts the project from a legacy *.visualstudio.com URL", () => {
		expect(
			extractAdoProject(
				"https://my-org.visualstudio.com/MyProject/_git/my-repo",
			),
		).toBe("MyProject");
	});

	it("extracts the project when the repo name contains dots", () => {
		expect(
			extractAdoProject(
				"https://dev.azure.com/example-org/Example_SaaS/_git/Example.Chat",
			),
		).toBe("Example_SaaS");
	});

	it("extracts the project from a legacy URL with a dotted repo name", () => {
		expect(
			extractAdoProject(
				"https://org.visualstudio.com/Proj/_git/my.repo.name",
			),
		).toBe("Proj");
	});

	it("is case-insensitive on the host segment", () => {
		expect(
			extractAdoProject("https://DEV.AZURE.COM/org/Proj/_git/repo"),
		).toBe("Proj");
	});

	it("returns undefined for a non-ADO URL (caller falls back to azureOrganization)", () => {
		expect(
			extractAdoProject("https://github.com/owner/repo"),
		).toBeUndefined();
	});

	it("returns undefined for a malformed / project-less ADO URL", () => {
		// No `/_git/` segment → cannot derive the project.
		expect(extractAdoProject("https://dev.azure.com/org")).toBeUndefined();
		expect(extractAdoProject("not-a-url")).toBeUndefined();
	});

	it("documents the azureOrganization fallback the route relies on", () => {
		// The route resolves `extractAdoProject(url) ?? azureOrganization`.
		// When the URL yields nothing, the fallback org stands in.
		const url = "https://github.com/owner/repo";
		const azureOrganization = "my-org";
		const resolved = extractAdoProject(url) ?? azureOrganization;
		expect(resolved).toBe("my-org");
	});
});
